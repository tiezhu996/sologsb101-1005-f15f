/**
 * 离线合并引擎（纯函数试算 + 事务落账）。
 *
 * 归属原则：主台账（桥梁 / 墩台 / 支座 / 步骤顺序 / 测点台账）是唯一归属方，
 * 现场包只提交执行事实。挂接一律按发放包里的稳定编号（step.id / point.id / bearing.id），
 * 绝不按步骤序号硬套。找不到归属的事实进待复核区并指出来源；
 * 存在未处理待复核记录的桥梁不允许归档。
 *
 * 幂等：已落账事实以 factId 记录在 fieldFacts；同一包再次导入不会重复生成读数 / 验收。
 * 检查点：导入失败保留原始包与报告（pending），可原样重试；成功保留报告（applied）。
 */
import { db, newId, putReading, putAcceptance, rowMeta } from './db';
import type { ReviewItemRow } from './db';
import { ACCEPTANCE_STAGE_LABEL } from '../types/acceptance';
import { STEP_STATE_LABEL } from '../types/step';
import type { FieldFact, FieldPackage } from '../types/field-package';
import type {
  MergeContextIndex,
  MergeEntry,
  MergePlan,
  MergeReport,
  ReviewReason,
} from '../types/merge';

/** 步骤状态流转权重（只允许向前推进，现场回退不覆盖主台账） */
const STATE_RANK = { idle: 0, lifting: 1, arrived: 2 } as const;

/** 构造当前主台账归属索引 */
export async function buildMergeContextIndex(): Promise<MergeContextIndex> {
  const [bridges, steps, points, bearings, factRecords, checkpoints] = await Promise.all([
    db.bridges.toArray(),
    db.steps.toArray(),
    db.points.toArray(),
    db.bearings.toArray(),
    db.fieldFacts.toArray(),
    db.importCheckpoints.where('status').equals('applied').toArray(),
  ]);
  return {
    bridges,
    stepIds: new Set(steps.map((step) => step.id)),
    bearingIds: new Set(bearings.map((bearing) => bearing.id)),
    pointIds: new Set(points.filter((point) => point.status === 'active').map((point) => point.id)),
    appliedFactIds: new Set(factRecords.map((record) => record.factId)),
    sealedPackageIds: new Set(checkpoints.map((checkpoint) => checkpoint.packageId)),
  };
}

function reviewItemFrom(
  pkg: FieldPackage,
  fact: FieldFact,
  reason: ReviewReason,
): ReviewItemRow {
  return {
    id: newId('review'),
    status: 'open',
    reason,
    factKind: fact.kind,
    sourcePackageId: pkg.packageId,
    sourceSealedAt: pkg.sealedAt,
    bridgeId: pkg.bridge.id,
    bridgeName: pkg.bridge.name,
    payload: fact,
    resolution: '',
    resolvedAt: '',
    ...rowMeta(),
  };
}

function targetLabel(fact: FieldFact): string {
  if (fact.kind === 'stepState') return `发放时第 ${fact.issuedSeq} 级步骤`;
  if (fact.kind === 'reading') return `发放时第 ${fact.issuedSeq} 级 / 测点 ${fact.pointCode}`;
  return `支座 ${fact.issuedBearingLabel}`;
}

/**
 * 纯函数试算：不写库，给出合并计划（报告 + 待复核行 + 落账行）。
 * 同一包已成功导入时，全部事实判为整包跳过，不产生任何副作用。
 */
export function planFieldPackageMerge(pkg: FieldPackage, index: MergeContextIndex): MergePlan {
  const entries: MergeEntry[] = [];
  const reviewItems: ReviewItemRow[] = [];
  type ReadingWrite = MergePlan['writes']['readings'][number];
  type AcceptanceWrite = MergePlan['writes']['acceptances'][number];
  const readings: ReadingWrite[] = [];
  const acceptances: AcceptanceWrite[] = [];
  const stepStates: MergePlan['writes']['stepStates'] = [];

  const bridgeExists = index.bridges.some((bridge) => bridge.id === pkg.bridge.id);
  const packageAlreadyApplied = index.sealedPackageIds.has(pkg.packageId);

  let readingsApplied = 0;
  let acceptancesApplied = 0;
  let stepStatesApplied = 0;
  let duplicateFacts = 0;
  let reviewCreated = 0;

  const pushReview = (fact: FieldFact, reason: ReviewReason): void => {
    reviewItems.push(reviewItemFrom(pkg, fact, reason));
    reviewCreated += 1;
    entries.push({
      factId: fact.factId,
      factKind: fact.kind,
      outcome: 'review',
      reason,
      target: targetLabel(fact),
      detail: bridgeExists ? '主台账找不到归属，转待复核区' : '主台账已无该桥梁，转待复核区',
    });
  };

  for (const fact of pkg.facts) {
    if (packageAlreadyApplied) {
      entries.push({
        factId: fact.factId,
        factKind: fact.kind,
        outcome: 'skipped-package-sealed',
        reason: null,
        target: targetLabel(fact),
        detail: `现场包 ${pkg.packageId} 已成功导入，整包跳过`,
      });
      duplicateFacts += 1;
      continue;
    }
    if (index.appliedFactIds.has(fact.factId)) {
      entries.push({
        factId: fact.factId,
        factKind: fact.kind,
        outcome: 'skipped-duplicate-fact',
        reason: null,
        target: targetLabel(fact),
        detail: '该事实此前已导入（factId 命中），跳过',
      });
      duplicateFacts += 1;
      continue;
    }

    if (!bridgeExists) {
      pushReview(fact, 'bridge-missing');
      continue;
    }

    if (fact.kind === 'stepState') {
      if (!index.stepIds.has(fact.stepId)) {
        pushReview(fact, 'step-missing');
        continue;
      }
      stepStates.push({ stepId: fact.stepId, state: fact.state, factId: fact.factId });
      stepStatesApplied += 1;
      entries.push({
        factId: fact.factId,
        factKind: fact.kind,
        outcome: 'applied',
        reason: null,
        target: `步骤 ${fact.stepId}`,
        detail: `状态推进为「${STEP_STATE_LABEL[fact.state]}」（按稳定步骤编号挂接，忽略序号变化）`,
      });
      continue;
    }

    if (fact.kind === 'reading') {
      if (!index.stepIds.has(fact.stepId)) {
        pushReview(fact, 'step-missing');
        continue;
      }
      if (!index.pointIds.has(fact.pointId)) {
        pushReview(fact, 'point-missing');
        continue;
      }
      readings.push({ factId: fact.factId, fact });
      readingsApplied += 1;
      entries.push({
        factId: fact.factId,
        factKind: fact.kind,
        outcome: 'applied',
        reason: null,
        target: `测点 ${fact.pointCode}（${fact.pointId}）`,
        detail: `生成读数：位移 ${fact.displacementMm} mm / 应力 ${fact.stressMpa} MPa`,
      });
      continue;
    }

    // acceptance
    if (!index.bearingIds.has(fact.bearingId)) {
      pushReview(fact, 'bearing-missing');
      continue;
    }
    acceptances.push({ factId: fact.factId, fact });
    acceptancesApplied += 1;
    entries.push({
      factId: fact.factId,
      factKind: fact.kind,
      outcome: 'applied',
      target: `支座 ${fact.issuedBearingLabel}（${fact.bearingId}）`,
      reason: null,
      detail: `生成验收：${ACCEPTANCE_STAGE_LABEL[fact.stage]} / ${fact.conclusion === 'pass' ? '合格' : '不合格'}`,
    });
  }

  const blockedBridge = reviewCreated > 0;
  const report: MergeReport = {
    packageId: pkg.packageId,
    bridgeId: pkg.bridge.id,
    bridgeName: pkg.bridge.name,
    appliedAt: new Date().toISOString(),
    readingsApplied,
    acceptancesApplied,
    stepStatesApplied,
    duplicateFacts,
    reviewCreated,
    blockedBridge,
    entries,
  };

  return { report, reviewItems, writes: { stepStates, readings, acceptances } };
}

/**
 * 正式合并：在单个 Dexie 事务内落账，主台账已有内容全部保留（只增 / 向前推进）。
 * 事务抛错时调用方保留检查点以便重试，本函数不吞异常。
 */
export async function applyFieldPackageMerge(pkg: FieldPackage, plan: MergePlan): Promise<MergeReport> {
  const { report, reviewItems, writes } = plan;
  await db.transaction(
    'rw',
    [db.readings, db.acceptances, db.steps, db.reviewItems, db.fieldFacts],
    async () => {
      // 步骤状态：只向前推进，不回退主台账
      for (const item of writes.stepStates) {
        const existing = await db.steps.get(item.stepId);
        if (!existing) continue;
        if (STATE_RANK[item.state] > STATE_RANK[existing.state]) {
          await db.steps.put({ ...existing, state: item.state });
        }
      }
      for (const reading of writes.readings) {
        await putReading({
          id: newId('read'),
          stepId: reading.fact.stepId,
          pointCode: reading.fact.pointCode,
          displacementMm: reading.fact.displacementMm,
          stressMpa: reading.fact.stressMpa,
          recordedAt: reading.fact.recordedAt,
          operator: reading.fact.operator,
          ...rowMeta(),
        });
      }
      for (const acceptance of writes.acceptances) {
        await putAcceptance({
          id: newId('acc'),
          bearingId: acceptance.fact.bearingId,
          stage: acceptance.fact.stage,
          conclusion: acceptance.fact.conclusion,
          acceptor: acceptance.fact.acceptor,
          acceptedAt: acceptance.fact.acceptedAt,
          ...rowMeta(),
        });
      }
      for (const review of reviewItems) {
        await db.reviewItems.put(review);
      }
      // 事实台账：记录所有已处理事实（含转待复核），重试 / 重导不重复处理
      for (const fact of pkg.facts) {
        await db.fieldFacts.put({
          factId: fact.factId,
          packageId: pkg.packageId,
          bridgeId: pkg.bridge.id,
          kind: fact.kind,
          fact,
          appliedAt: new Date().toISOString(),
        });
      }
    },
  );
  return report;
}
