/**
 * 现场作业包离线合并引擎（纯函数 + Dexie 事务）。
 *
 * 归属边界：
 * - 主台账拥有桥梁 / 墩台 / 支座 / 步骤顺序 / 测点布设计划；
 * - 现场包只提交执行事实（步骤状态、测点读数、分步验收），绝不回写台账结构字段。
 *
 * 挂接与放行规则：
 * - 读数按发放包内的 pointId 稳定编号挂接，其次才回退 stepId+pointCode；绝不按步骤序号 seq 挂接；
 * - 主台账重排步骤不影响落位；替换支座 / 撤去测点 / 删除步骤导致找不到归属的事实进待复核区；
 * - 待复核存在 pending 记录的桥梁不放行归档（见 bridgesBlockedByOrphans）；
 * - 合并全程单事务：失败回滚不留半成品，同时保留检查点（整包原文）供重试；
 * - 以 packageId 为幂等键：已成功的包再次导入直接跳过，不重复生成读数 / 验收，主台账已有内容保留。
 */
import {
  db,
  getImportBatch,
  putImportBatch,
  type AcceptanceRow,
  type FieldOrphanDbRow,
  type PointDbRow,
  type ReadingRow,
} from './db';
import { ROW_REVISION } from '../types/persistence';
import {
  pointIdOf,
  stepStateWeight,
  validateFieldPackage,
  type FieldAcceptanceFact,
  type FieldBearingAnchor,
  type FieldOrphanReason,
  type FieldPackage,
  type FieldPointAnchor,
  type FieldReadingFact,
  type FieldStepAnchor,
  type FieldStepFact,
  type FieldMergeReport,
} from '../types/field-package';

/** 现场事实在主台账的统一前缀，与主台账自建 id 区分 */
const FACT_READING_PREFIX = 'fldread';
const FACT_ACCEPTANCE_PREFIX = 'fldacc';

/* ============================== 发放现场包 ============================== */

export interface IssuePackageInput {
  bridgeId: string;
  deviceCode?: string;
}

/**
 * 按主台账当前状态生成现场作业包：锚点携带稳定编号，
 * 步骤 seq 仅作为平板展示顺序（导入不按它挂接）。
 */
export async function buildFieldPackage(input: IssuePackageInput): Promise<FieldPackage> {
  const bridge = await db.bridges.get(input.bridgeId);
  if (!bridge) throw new Error(`主台账不存在桥梁 ${input.bridgeId}，无法发放现场包`);

  const [steps, points, piers, bearings] = await Promise.all([
    db.steps.where('bridgeId').equals(input.bridgeId).toArray(),
    db.points.toArray(),
    db.piers.where('bridgeId').equals(input.bridgeId).toArray(),
    db.bearings.toArray(),
  ]);

  const orderedSteps = [...steps].sort((a, b) => a.seq - b.seq);
  const stepIds = new Set(orderedSteps.map((item) => item.id));
  const pierIds = new Set(piers.map((item) => item.id));

  const stepAnchors: FieldStepAnchor[] = orderedSteps.map((step) => ({
    stepId: step.id,
    seq: step.seq,
    targetLiftMm: step.targetLiftMm,
    limitMm: step.limitMm,
    state: step.state,
  }));

  const pointAnchors: FieldPointAnchor[] = points
    .filter((point) => stepIds.has(point.stepId) && point.active === 1)
    .map((point) => ({ pointId: point.id, stepId: point.stepId, pointCode: point.pointCode }));

  const pierCode = new Map(piers.map((pier) => [pier.id, pier.code]));
  const bearingAnchors: FieldBearingAnchor[] = bearings
    .filter((bearing) => pierIds.has(bearing.pierId))
    .map((bearing) => ({
      bearingId: bearing.id,
      pierCode: pierCode.get(bearing.pierId) ?? '未知墩台',
      serial: bearing.serial,
      spec: bearing.spec,
    }));

  return {
    kind: 'gbbridgebear-field-package',
    packageVersion: 1,
    packageId: `fldpkg-${input.bridgeId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    bridgeId: bridge.id,
    bridgeName: bridge.name,
    issuedAt: new Date().toISOString(),
    ...(input.deviceCode ? { deviceCode: input.deviceCode } : {}),
    anchors: { steps: stepAnchors, points: pointAnchors, bearings: bearingAnchors },
    facts: { steps: [], readings: [], acceptances: [] },
  };
}

/* ============================== 合并结果异常 ============================== */

/** 结构性错误：包无法解析，不建立检查点（无有效 packageId 可追溯） */
export class FieldPackageFormatError extends Error {}

/** 归属错误：包结构合法但桥梁在主台账不存在；建立失败检查点，支持换库后重试 */
export class FieldPackageBridgeMissingError extends Error {
  constructor(
    public readonly packageId: string,
    public readonly bridgeId: string,
  ) {
    super(`主台账不存在桥梁 ${bridgeId}（包 ${packageId}），请确认是否选错项目库后重试`);
    this.name = 'FieldPackageBridgeMissingError';
  }
}

/* ============================== 合并引擎 ============================== */

function orphanId(packageId: string, kind: FieldOrphanDbRow['kind'], factId: string): string {
  return `orphan-${packageId}-${kind}-${factId}`;
}

export interface ImportFieldPackageOptions {
  fileName?: string;
}

/**
 * 合并一个现场包。
 *
 * 流程：
 * 1. 结构校验（失败抛 FieldPackageFormatError，不写检查点）；
 * 2. 幂等短路：packageId 已 succeeded → 直接回放上一次报告，不产生任何写入；
 * 3. 桥梁归属校验（失败先落 failed 检查点再抛错，事务内检测保证可重试）；
 * 4. 单事务合并：步骤状态单调推进、读数/验收按稳定编号 upsert、无归属事实写待复核区；
 * 5. 成功后批次置 succeeded；事务任何一步失败整体回滚，failed 批次保留整包原文作为检查点。
 */
export async function importFieldPackage(
  input: unknown,
  options: ImportFieldPackageOptions = {},
): Promise<FieldMergeReport> {
  // 1. 结构校验
  const checked = validateFieldPackage(input);
  if (!checked.ok) throw new FieldPackageFormatError(checked.error);
  const pkg = checked.pkg;

  // 2. 幂等短路：已成功的包再次导入不重复生成
  const existed = await getImportBatch(pkg.packageId);
  if (existed?.status === 'succeeded' && existed.lastReport) {
    const report = JSON.parse(existed.lastReport) as FieldMergeReport;
    return { ...report, duplicated: true };
  }

  // 3 & 4：先做归属预检（失败保留检查点），通过后进入单事务合并
  const bridge = await db.bridges.get(pkg.bridgeId);
  if (!bridge) {
    await recordCheckpoint(pkg, options.fileName, new FieldPackageBridgeMissingError(pkg.packageId, pkg.bridgeId).message);
    throw new FieldPackageBridgeMissingError(pkg.packageId, pkg.bridgeId);
  }

  const now = new Date().toISOString();
  const report = await db.transaction(
    'rw',
    [
      db.bridges,
      db.piers,
      db.bearings,
      db.steps,
      db.points,
      db.readings,
      db.acceptances,
      db.fieldOrphans,
      db.importBatches,
    ],
    async (): Promise<FieldMergeReport> => {
      // 事务内再校验一次桥梁（与检查点写入处于不同连接视图，保证失败也不留半成品）
      if (!(await db.bridges.get(pkg.bridgeId))) {
        throw new FieldPackageBridgeMissingError(pkg.packageId, pkg.bridgeId);
      }

      const [masterSteps, masterPoints, masterReadings, masterAcceptances, masterOrphans] = await Promise.all([
        db.steps.where('bridgeId').equals(pkg.bridgeId).toArray(),
        db.points.toArray(),
        db.readings.toArray(),
        db.acceptances.toArray(),
        db.fieldOrphans.toArray(),
      ]);

      const stepById = new Map(masterSteps.map((item) => [item.id, item]));
      const pointById = new Map(masterPoints.map((item) => [item.id, item]));
      const bridgePiers = await db.piers.where('bridgeId').equals(pkg.bridgeId).toArray();
      const bridgeBearings = bridgePiers.length
        ? await db.bearings.where('pierId').anyOf(bridgePiers.map((pier) => pier.id)).toArray()
        : [];
      const bearingIds = new Set(bridgeBearings.map((bearing) => bearing.id));

      const result: FieldMergeReport = {
        packageId: pkg.packageId,
        bridgeId: pkg.bridgeId,
        duplicated: false,
        stepsApplied: 0,
        readingsInserted: 0,
        readingsSkipped: 0,
        acceptancesInserted: 0,
        acceptancesSkipped: 0,
        pointsCreated: 0,
        orphansCreated: 0,
        orphanReasons: [],
      };
      const orphanReasons = new Set<FieldOrphanReason>();

      const existingReadings = new Set(masterReadings.map((item) => item.id));
      const existingAcceptanceKeys = new Set(masterAcceptances.map((item) => `${item.bearingId}|${item.stage}`));
      const existingOrphanIds = new Set(masterOrphans.map((item) => item.id));

      const putOrphan = async (
        kind: FieldOrphanDbRow['kind'],
        reason: FieldOrphanReason,
        payload: FieldStepFact | FieldReadingFact | FieldAcceptanceFact,
      ): Promise<void> => {
        const id = orphanId(pkg.packageId, kind, payload.factId);
        // 已作废的同来源记录不被重试自动复活；已挂接 / 已存在则不动
        const previous = masterOrphans.find((item) => item.id === id);
        if (previous && previous.status !== 'pending') return;
        if (existingOrphanIds.has(id)) return;
        existingOrphanIds.add(id);
        const row: FieldOrphanDbRow = {
          id,
          packageId: pkg.packageId,
          bridgeId: pkg.bridgeId,
          ...(pkg.deviceCode ? { deviceCode: pkg.deviceCode } : {}),
          kind,
          reason,
          status: 'pending',
          payload: payload as FieldOrphanDbRow['payload'],
          createdAt: now,
        };
        await db.fieldOrphans.put(row);
        result.orphansCreated += 1;
        orphanReasons.add(reason);
      };

      /* ---- 步骤状态事实：只按稳定 stepId 挂接，状态单调推进，不碰 seq ---- */
      for (const fact of pkg.facts.steps) {
        const step = stepById.get(fact.stepId);
        if (!step) {
          await putOrphan('step', 'step-missing', fact);
          continue;
        }
        if (stepStateWeight(fact.state) > stepStateWeight(step.state)) {
          await db.steps.put({ ...step, state: fact.state });
          result.stepsApplied += 1;
        }
      }

      /* ---- 测点读数事实：按事实步骤 + 测点号的稳定编号挂接，绝不按 seq ---- */
      const pointsToPut: PointDbRow[] = [];
      const readingsToPut: ReadingRow[] = [];
      for (const fact of pkg.facts.readings) {
        const step = stepById.get(fact.stepId);
        if (!step) {
          await putOrphan('reading', 'step-missing', fact);
          continue;
        }
        // 稳定编号挂接：以事实自身 stepId+pointCode 派生的稳定编号为落库键；
        // 同时识别包内显式 pointId 锚点。命中的测点必须属于该事实步骤，杜绝跨步骤误挂。
        const stablePointId = pointIdOf(fact.stepId, fact.pointCode);
        const candidateIds = fact.pointId && fact.pointId !== stablePointId ? [fact.pointId, stablePointId] : [stablePointId];
        const point = candidateIds
          .map((id) => pointById.get(id))
          .find((candidate) => candidate && candidate.stepId === fact.stepId);
        if (point && point.active === 0) {
          // 主台账已撤去该测点：读数进待复核区，等待人工判定
          await putOrphan('reading', 'point-retired', fact);
          continue;
        }
        if (!point) {
          // 主台账该步骤无此测点计划：自动补登为启用测点（现场增设测点），不静默丢数
          const created: PointDbRow = {
            id: stablePointId,
            stepId: fact.stepId,
            pointCode: fact.pointCode,
            active: 1,
            createdByPackageId: pkg.packageId,
            createdAt: now,
          };
          pointsToPut.push(created);
          pointById.set(stablePointId, created);
          result.pointsCreated += 1;
        }
        const readingId = `read-${FACT_READING_PREFIX}-${pkg.packageId}-${fact.factId}`;
        if (existingReadings.has(readingId)) {
          result.readingsSkipped += 1;
          continue;
        }
        existingReadings.add(readingId);
        readingsToPut.push({
          id: readingId,
          stepId: fact.stepId,
          pointId: stablePointId,
          pointCode: fact.pointCode,
          displacementMm: fact.displacementMm,
          stressMpa: fact.stressMpa,
          recordedAt: fact.recordedAt,
          operator: fact.operator,
          sourcePackageId: pkg.packageId,
          createdAt: now,
          revision: ROW_REVISION,
        });
        result.readingsInserted += 1;
      }
      if (pointsToPut.length) await db.points.bulkPut(pointsToPut);
      if (readingsToPut.length) await db.readings.bulkPut(readingsToPut);

      /* ---- 分步验收事实：按稳定 bearingId 挂接；同支座同阶段唯一，重复跳过 ---- */
      const acceptancesToPut: AcceptanceRow[] = [];
      for (const fact of pkg.facts.acceptances) {
        if (!bearingIds.has(fact.bearingId)) {
          // 支座已被替换 / 删除：验收进待复核区
          await putOrphan('acceptance', 'bearing-missing', fact);
          continue;
        }
        const key = `${fact.bearingId}|${fact.stage}`;
        if (existingAcceptanceKeys.has(key)) {
          result.acceptancesSkipped += 1;
          continue;
        }
        existingAcceptanceKeys.add(key);
        acceptancesToPut.push({
          id: `${FACT_ACCEPTANCE_PREFIX}-${pkg.packageId}-${fact.factId}`,
          bearingId: fact.bearingId,
          stage: fact.stage,
          conclusion: fact.conclusion,
          acceptor: fact.acceptor,
          acceptedAt: fact.acceptedAt,
          sourcePackageId: pkg.packageId,
          createdAt: now,
          revision: ROW_REVISION,
        });
        result.acceptancesInserted += 1;
      }
      if (acceptancesToPut.length) await db.acceptances.bulkPut(acceptancesToPut);

      result.orphanReasons = [...orphanReasons];

      // 成功批次（含完整原文，便于追溯；不影响幂等判定）
      await db.importBatches.put({
        packageId: pkg.packageId,
        bridgeId: pkg.bridgeId,
        bridgeName: pkg.bridgeName,
        ...(pkg.deviceCode ? { deviceCode: pkg.deviceCode } : {}),
        ...(options.fileName ? { fileName: options.fileName } : {}),
        status: 'succeeded',
        importedAt: now,
        lastReport: JSON.stringify(result),
        packageJson: JSON.stringify(pkg),
      });

      return result;
    },
  );

  return report;
}

/** 失败检查点：结构合法但无法合并（如桥梁缺失）时保留整包原文 */
async function recordCheckpoint(pkg: FieldPackage, fileName: string | undefined, error: string): Promise<void> {
  const now = new Date().toISOString();
  await putImportBatch({
    packageId: pkg.packageId,
    bridgeId: pkg.bridgeId,
    bridgeName: pkg.bridgeName,
    ...(pkg.deviceCode ? { deviceCode: pkg.deviceCode } : {}),
    ...(fileName ? { fileName } : {}),
    status: 'failed',
    importedAt: now,
    error,
    packageJson: JSON.stringify(pkg),
  });
}

/* ============================== 待复核复核处理 ============================== */

/** 读数孤儿复核：重新挂到现存步骤的测点（测点被撤时可选择同编号已启用测点或新设编号） */
export async function resolveReadingOrphan(input: {
  orphanId: string;
  targetStepId: string;
  targetPointCode: string;
  note?: string;
}): Promise<void> {
  await db.transaction('rw', [db.fieldOrphans, db.steps, db.points, db.readings], async () => {
    const orphan = await db.fieldOrphans.get(input.orphanId);
    if (!orphan || orphan.kind !== 'reading' || orphan.status !== 'pending') return;
    const step = await db.steps.get(input.targetStepId);
    if (!step) throw new Error('目标步骤不存在，无法挂接');
    const code = input.targetPointCode.trim();
    if (!code) throw new Error('请填写测点编号');
    const pointId = pointIdOf(input.targetStepId, code);
    const point = await db.points.get(pointId);
    if (point?.active === 0) throw new Error('目标测点已撤去，请先恢复测点或更换编号');
    if (!point) {
      await db.points.put({
        id: pointId,
        stepId: input.targetStepId,
        pointCode: code,
        active: 1,
        createdByPackageId: orphan.packageId,
        createdAt: new Date().toISOString(),
      });
    }
    const fact = orphan.payload as FieldReadingFact;
    const now = new Date().toISOString();
    await db.readings.put({
      id: `read-fldorph-${orphan.id}`,
      stepId: input.targetStepId,
      pointId,
      pointCode: code,
      displacementMm: fact.displacementMm,
      stressMpa: fact.stressMpa,
      recordedAt: fact.recordedAt,
      operator: fact.operator,
      sourcePackageId: orphan.packageId,
      createdAt: now,
      revision: ROW_REVISION,
    });
    await db.fieldOrphans.put({
      ...orphan,
      status: 'resolved',
      resolvedAt: now,
      resolveNote: `挂接到步骤 ${input.targetStepId} 测点 ${code}${input.note ? `；${input.note}` : ''}`,
    });
  });
}

/** 验收孤儿复核：重新挂到现存支座 */
export async function resolveAcceptanceOrphan(input: {
  orphanId: string;
  targetBearingId: string;
  note?: string;
}): Promise<void> {
  await db.transaction('rw', [db.fieldOrphans, db.bearings, db.acceptances], async () => {
    const orphan = await db.fieldOrphans.get(input.orphanId);
    if (!orphan || orphan.kind !== 'acceptance' || orphan.status !== 'pending') return;
    const bearing = await db.bearings.get(input.targetBearingId);
    if (!bearing) throw new Error('目标支座不存在，无法挂接');
    const fact = orphan.payload as FieldAcceptanceFact;
    const now = new Date().toISOString();
    // 目标支座该阶段已有验收时不覆盖主台账内容，改为作废并提示
    const duplicated = await db.acceptances
      .where('bearingId')
      .equals(input.targetBearingId)
      .toArray();
    if (duplicated.some((item) => item.stage === fact.stage)) {
      throw new Error('目标支座该分步已有验收记录，主台账内容保留；如确需采用现场结论请先处理原记录');
    }
    await db.acceptances.put({
      id: `acc-fldorph-${orphan.id}`,
      bearingId: input.targetBearingId,
      stage: fact.stage,
      conclusion: fact.conclusion,
      acceptor: fact.acceptor,
      acceptedAt: fact.acceptedAt,
      sourcePackageId: orphan.packageId,
      createdAt: now,
      revision: ROW_REVISION,
    });
    await db.fieldOrphans.put({
      ...orphan,
      status: 'resolved',
      resolvedAt: now,
      resolveNote: `挂接到支座 ${input.targetBearingId}${input.note ? `；${input.note}` : ''}`,
    });
  });
}

/** 作废孤儿（步骤状态事实无对应实体重挂入口，只能作废；读数 / 验收确认无效也可作废） */
export async function discardOrphan(orphanId: string, note?: string): Promise<void> {
  const existing = await db.fieldOrphans.get(orphanId);
  if (!existing || existing.status !== 'pending') return;
  await db.fieldOrphans.put({
    ...existing,
    status: 'discarded',
    resolvedAt: new Date().toISOString(),
    resolveNote: note ? `作废：${note}` : '作废：经复核不予采纳',
  });
}

/* ============================== 归档放行闸门 ============================== */

/** 存在待复核记录的桥梁 id：这些桥处理完待复核前不放行归档 */
export async function bridgeIdsBlockedByOrphans(): Promise<Set<string>> {
  const pending = await db.fieldOrphans.where('status').equals('pending').toArray();
  return new Set(pending.map((item) => item.bridgeId));
}

/** 单桥待复核数量（供页面归档按钮拦截提示） */
export async function pendingOrphanCountOfBridge(bridgeId: string): Promise<number> {
  return db.fieldOrphans.where('[bridgeId+status]').equals([bridgeId, 'pending']).count();
}

/** 从失败检查点重试：取批次保存的整包原文重新走合并 */
export async function retryFailedImport(packageId: string): Promise<FieldMergeReport> {
  const batch = await getImportBatch(packageId);
  if (!batch) throw new Error('检查点已不存在，无法重试');
  if (batch.status !== 'failed') throw new Error('该批次不是失败检查点，无需重试');
  let parsed: unknown;
  try {
    parsed = JSON.parse(batch.packageJson);
  } catch {
    throw new Error('检查点中的现场包原文已损坏');
  }
  return importFieldPackage(parsed, { fileName: batch.fileName });
}

/** 删除失败检查点（放弃该包，不影响主台账） */
export async function discardImportCheckpoint(packageId: string): Promise<void> {
  const batch = await getImportBatch(packageId);
  if (batch?.status === 'failed') await db.importBatches.delete(packageId);
}
