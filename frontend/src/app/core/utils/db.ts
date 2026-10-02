/**
 * IndexedDB 持久化层（Dexie 封装）· 桥梁支座更换与顶升监测台
 * - 数据结构版本号 + 升级迁移逻辑
 * - 各实体表增删改查（含级联删除）
 * - 首屏自动播种互相引用的演示数据（桥梁 → 墩台 → 支座 / 顶升步骤 → 测点读数 / 分步验收）
 * 纯前端应用：不依赖任何后端或数据库服务
 */
import Dexie, { type Table } from 'dexie';
import type { Bridge } from '../types/bridge';
import type { Pier } from '../types/pier';
import type { Bearing, DiseaseGrade } from '../types/bearing';
import type { Step, SyncRequirement } from '../types/step';
import type { Reading } from '../types/reading';
import type { Acceptance, AcceptanceStage } from '../types/acceptance';
import { ROW_REVISION, type Revisioned } from '../types/persistence';
import type {
  FieldDraftRow,
  FieldImportBatchRow,
  FieldOrphanRow,
  PointRow,
} from '../types/field-package';
import { pointIdOf } from '../types/field-package';

/** 浏览器 IndexedDB 库名 */
export const DB_NAME = 'gbbridgebear';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

export { ROW_REVISION };
export type { Revisioned };

export type BridgeRow = Bridge;
export type PierRow = Pier;
export type BearingRow = Bearing;
export type StepRow = Step;
export type ReadingRow = Reading;
export type AcceptanceRow = Acceptance;
export type PointDbRow = PointRow;
export type FieldOrphanDbRow = FieldOrphanRow;
export type FieldImportBatchDbRow = FieldImportBatchRow;
export type FieldDraftDbRow = FieldDraftRow;

class BridgeBearingDatabase extends Dexie {
  bridges!: Table<BridgeRow, string>;
  piers!: Table<PierRow, string>;
  bearings!: Table<BearingRow, string>;
  steps!: Table<StepRow, string>;
  readings!: Table<ReadingRow, string>;
  acceptances!: Table<AcceptanceRow, string>;
  /** 测点布设计划（主台账归属，可软撤） */
  points!: Table<PointDbRow, string>;
  /** 待复核区：找不到归属的现场执行事实 */
  fieldOrphans!: Table<FieldOrphanDbRow, string>;
  /** 现场包导入批次与失败检查点（整包原文 + 状态，支持重试与幂等） */
  importBatches!: Table<FieldImportBatchDbRow, string>;
  /** 平板现场登记草稿（断网暂存） */
  fieldDrafts!: Table<FieldDraftDbRow, string>;
  settings!: Table<{ id: string; value: string; updatedAt: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（保留历史数据）
    this.version(1).stores({
      bridges: 'id, name, bridgeType, builtYear',
      piers: 'id, bridgeId, code',
      bearings: 'id, pierId, diseaseGrade, type',
      steps: 'id, bridgeId, seq, state',
      readings: 'id, stepId, pointCode',
      acceptances: 'id, bearingId, stage, conclusion',
    });

    // v2：新增 revision 行修订号；支座补充组合索引便于按墩台批量评级，
    //     顶升步骤补充同步要求索引，验收补充组合索引，并新增 settings 表
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bridges: 'id, name, bridgeType, builtYear, roadClass, archived',
        piers: 'id, bridgeId, code, capElevation, [bridgeId+code]',
        bearings: 'id, pierId, diseaseGrade, type, serial, [pierId+serial]',
        steps: 'id, bridgeId, seq, state, syncRequirement, [bridgeId+seq]',
        readings: 'id, stepId, pointCode, recordedAt, [stepId+pointCode]',
        acceptances: 'id, bearingId, stage, conclusion, [bearingId+stage]',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        const tables: Array<Table<Record<string, unknown>, string>> = [
          tx.table('bridges'),
          tx.table('piers'),
          tx.table('bearings'),
          tx.table('steps'),
          tx.table('readings'),
          tx.table('acceptances'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = new Date().toISOString();
          });
        }
        // 迁移：旧版桥梁缺少 archived 字段
        await tx.table('bridges').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.archived !== 'boolean') row.archived = false;
          if (typeof row.spanCombo !== 'string' && typeof row.span === 'string') row.spanCombo = row.span;
        });
        // 迁移：旧版支座字段 grade → diseaseGrade
        await tx.table('bearings').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.diseaseGrade !== 'string' && typeof row.grade === 'string') {
            row.diseaseGrade = row.grade;
          }
          if (typeof row.diseaseNote !== 'string') row.diseaseNote = '';
        });
        // 迁移：旧版步骤字段 syncType → syncRequirement，limit → limitMm
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.syncRequirement !== 'string' && typeof row.syncType === 'string') {
            row.syncRequirement = row.syncType;
          }
          if (typeof row.limitMm !== 'number' && typeof row.limit === 'number') row.limitMm = row.limit;
          if (typeof row.targetLiftMm !== 'number' && typeof row.lift === 'number') row.targetLiftMm = row.lift;
        });
      });

    // v3：离线现场作业包合并能力
    //   - 新增 points 测点布设计划（主台账可撤去测点，导入按稳定编号挂接）
    //   - 新增 fieldOrphans 待复核区、importBatches 导入批次/失败检查点、fieldDrafts 现场草稿
    //   - readings / acceptances 增补 pointId / sourcePackageId 字段（在 upgrade 中补齐）
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bridges: 'id, name, bridgeType, builtYear, roadClass, archived',
        piers: 'id, bridgeId, code, capElevation, [bridgeId+code]',
        bearings: 'id, pierId, diseaseGrade, type, serial, [pierId+serial]',
        steps: 'id, bridgeId, seq, state, syncRequirement, [bridgeId+seq]',
        readings: 'id, stepId, pointId, pointCode, recordedAt, [stepId+pointCode]',
        acceptances: 'id, bearingId, stage, conclusion, sourcePackageId, [bearingId+stage]',
        points: 'id, stepId, pointCode, active, [stepId+pointCode]',
        fieldOrphans: 'id, packageId, bridgeId, kind, reason, status, [bridgeId+status]',
        importBatches: 'packageId, bridgeId, status, importedAt',
        fieldDrafts: 'packageId, bridgeId, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        // 既有读数补行修订号与稳定测点编号；既有验收补行修订号
        await tx.table('readings').toCollection().modify((row: Record<string, unknown>) => {
          row.revision = ROW_REVISION;
          if (typeof row.stepId === 'string' && typeof row.pointCode === 'string') {
            row.pointId = pointIdOf(row.stepId, row.pointCode);
          }
        });
        await tx
          .table('acceptances')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
          });
        // 既有读数反推测点台账：每个步骤出现过的测点编号补登为启用测点
        const pointsTable = tx.table<PointDbRow, string>('points');
        const seen = new Set<string>();
        await tx.table<ReadingRow, string>('readings').each((reading) => {
          const id = reading.pointId ?? pointIdOf(reading.stepId, reading.pointCode);
          if (seen.has(id)) return;
          seen.add(id);
          pointsTable.put({
            id,
            stepId: reading.stepId,
            pointCode: reading.pointCode,
            active: 1,
            createdAt: reading.createdAt,
          });
        });
      });
  }
}

export const db = new BridgeBearingDatabase();

/* ============================== 演示数据播种 ============================== */

function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function dateTimeText(offsetDays: number, hour: number, minute: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:${pad(minute)}`;
}

interface SeedBridgeSpec {
  name: string;
  spanCombo: string;
  bridgeType: Bridge['bridgeType'];
  builtYear: number;
  roadClass: Bridge['roadClass'];
  piers: Array<{
    code: string;
    capElevation: number;
    type: Pier['type'];
    bearings: Array<{ serial: string; type: Bearing['type']; spec: string; grade: DiseaseGrade; note: string }>;
  }>;
  steps: Array<{ targetLiftMm: number; sync: SyncRequirement; limitMm: number; leader: string; state: Step['state'] }>;
}

const SEED_BRIDGES: SeedBridgeSpec[] = [
  {
    name: '沙河大桥',
    spanCombo: '3×30m',
    bridgeType: 'beam',
    builtYear: 2006,
    roadClass: 'expressway',
    piers: [
      {
        code: '0#台',
        capElevation: 42.35,
        type: 'abutment',
        bearings: [
          { serial: '1', type: 'plate', spec: 'GJZ 300×400', grade: 'moderate', note: '支座剪切变形 8mm，垫石局部破损' },
          { serial: '2', type: 'plate', spec: 'GJZ 300×400', grade: 'slight', note: '表面轻微老化开裂' },
        ],
      },
      {
        code: '1#墩',
        capElevation: 41.12,
        type: 'pier',
        bearings: [
          { serial: '1', type: 'pot', spec: 'GPZ 2000', grade: 'severe', note: '上座板锈蚀严重，位移超限' },
          { serial: '2', type: 'pot', spec: 'GPZ 2000', grade: 'intact', note: '状态完好' },
          { serial: '3', type: 'pot', spec: 'GPZ 2000', grade: 'moderate', note: '防尘罩破损，滑板外露' },
        ],
      },
      {
        code: '2#墩',
        capElevation: 40.86,
        type: 'pier',
        bearings: [
          { serial: '1', type: 'spherical', spec: 'GQZ 3000', grade: 'slight', note: '转动轻微异响' },
          { serial: '2', type: 'spherical', spec: 'GQZ 3000', grade: 'severe', note: '球冠板裂纹，需更换' },
        ],
      },
    ],
    steps: [
      { targetLiftMm: 3, sync: 'sync', limitMm: 12, leader: '陈立强', state: 'arrived' },
      { targetLiftMm: 4, sync: 'cross', limitMm: 12, leader: '陈立强', state: 'lifting' },
      { targetLiftMm: 5, sync: 'single', limitMm: 15, leader: '赵启明', state: 'idle' },
    ],
  },
  {
    name: '云溪河特大桥',
    spanCombo: '5×40m',
    bridgeType: 'arch',
    builtYear: 2013,
    roadClass: 'first',
    piers: [
      {
        code: '0#台',
        capElevation: 58.2,
        type: 'abutment',
        bearings: [
          { serial: '1', type: 'pot', spec: 'GPZ 3000', grade: 'intact', note: '状态完好' },
          { serial: '2', type: 'pot', spec: 'GPZ 3000', grade: 'moderate', note: '位移标尺脱落，需复核' },
        ],
      },
      {
        code: '1#墩',
        capElevation: 57.44,
        type: 'transition',
        bearings: [
          { serial: '1', type: 'spherical', spec: 'GQZ 4000', grade: 'severe', note: '支座脱空 3mm，顶升更换' },
          { serial: '2', type: 'spherical', spec: 'GQZ 4000', grade: 'moderate', note: '滑板磨损，摩擦系数偏大' },
        ],
      },
    ],
    steps: [
      { targetLiftMm: 4, sync: 'sync', limitMm: 10, leader: '赵启明', state: 'lifting' },
      { targetLiftMm: 6, sync: 'cross', limitMm: 10, leader: '赵启明', state: 'idle' },
    ],
  },
];

/**
 * 播种：2 座桥梁 × 各 2~3 个墩台 × 各 2~3 个支座 + 顶升步骤 + 每步测点读数 + 分步验收。
 * 数据父子互相引用（bridgeId / pierId / bearingId / stepId），全部页面打开即有内容。
 */
async function seedDatabase(): Promise<void> {
  const random = makeRandom(20260824);
  const stamp = new Date().toISOString();

  const bridges: BridgeRow[] = [];
  const piers: PierRow[] = [];
  const bearings: BearingRow[] = [];
  const steps: StepRow[] = [];
  const readings: ReadingRow[] = [];
  const acceptances: AcceptanceRow[] = [];
  const points: PointDbRow[] = [];
  const seededPointIds = new Set<string>();

  const operators = ['陈立强', '赵启明', '李清和', '周文斌'];
  const acceptors = ['王监理', '李总监'];

  SEED_BRIDGES.forEach((bridgeSpec, bridgeIndex) => {
    const bridgeId = `bridge-${bridgeIndex + 1}`;
    bridges.push({
      id: bridgeId,
      name: bridgeSpec.name,
      spanCombo: bridgeSpec.spanCombo,
      bridgeType: bridgeSpec.bridgeType,
      builtYear: bridgeSpec.builtYear,
      roadClass: bridgeSpec.roadClass,
      archived: false,
      createdAt: stamp,
      revision: ROW_REVISION,
    });

    bridgeSpec.piers.forEach((pierSpec, pierIndex) => {
      const pierId = `pier-${bridgeIndex + 1}-${pierIndex + 1}`;
      piers.push({
        id: pierId,
        bridgeId,
        code: pierSpec.code,
        capElevation: pierSpec.capElevation,
        type: pierSpec.type,
        bearingCount: pierSpec.bearings.length,
        createdAt: stamp,
        revision: ROW_REVISION,
      });

      pierSpec.bearings.forEach((bearingSpec, bearingIndex) => {
        const bearingId = `bearing-${bridgeIndex + 1}-${pierIndex + 1}-${bearingIndex + 1}`;
        bearings.push({
          id: bearingId,
          pierId,
          serial: bearingSpec.serial,
          type: bearingSpec.type,
          spec: bearingSpec.spec,
          diseaseGrade: bearingSpec.grade,
          diseaseNote: bearingSpec.note,
          createdAt: stamp,
          revision: ROW_REVISION,
        });

        // 验收：完好 / 轻微支座完成前两步，其余按序推进
        const passedCount =
          bearingSpec.grade === 'intact' ? 4 : bearingSpec.grade === 'slight' ? 2 : bearingSpec.grade === 'moderate' ? 1 : 0;
        const stageList: AcceptanceStage[] = ['lifted', 'bearingPlaced', 'beamLowered', 'completed'];
        for (let stageIndex = 0; stageIndex < passedCount; stageIndex += 1) {
          acceptances.push({
            id: `acc-${bearingId}-${stageIndex + 1}`,
            bearingId,
            stage: stageList[stageIndex],
            conclusion: 'pass',
            acceptor: acceptors[stageIndex % acceptors.length],
            acceptedAt: dateTimeText(-3 + stageIndex, 10 + stageIndex, 30),
            createdAt: stamp,
            revision: ROW_REVISION,
          });
        }
      });
    });

    bridgeSpec.steps.forEach((stepSpec, stepIndex) => {
      const stepId = `step-${bridgeIndex + 1}-${stepIndex + 1}`;
      steps.push({
        id: stepId,
        bridgeId,
        seq: stepIndex + 1,
        targetLiftMm: stepSpec.targetLiftMm,
        syncRequirement: stepSpec.sync,
        limitMm: stepSpec.limitMm,
        leader: stepSpec.leader,
        state: stepSpec.state,
        createdAt: stamp,
        revision: ROW_REVISION,
      });

      // 测点布设计划：所有步骤（含未开始）都有计划测点，撤去测点在现场页操作
      const pointCount = stepSpec.sync === 'single' ? 1 : 4;
      for (let point = 0; point < pointCount; point += 1) {
        const pointCode = `P${point + 1}`;
        const id = pointIdOf(stepId, pointCode);
        if (seededPointIds.has(id)) continue;
        seededPointIds.add(id);
        points.push({ id, stepId, pointCode, active: 1, createdAt: stamp });
      }

      // 未开始的步骤不产生读数
      if (stepSpec.state === 'idle') return;
      const rounds = stepSpec.state === 'arrived' ? 3 : 2;
      for (let round = 0; round < rounds; round += 1) {
        for (let point = 0; point < pointCount; point += 1) {
          const base = stepSpec.targetLiftMm * ((round + 1) / (rounds + 1));
          const jitter = (random() - 0.5) * 1.4;
          const pointCode = `P${point + 1}`;
          readings.push({
            id: `read-${stepId}-${round + 1}-${point + 1}`,
            stepId,
            pointId: pointIdOf(stepId, pointCode),
            pointCode,
            displacementMm: Number((base + jitter).toFixed(2)),
            stressMpa: Number((7 + random() * 6).toFixed(2)),
            recordedAt: dateTimeText(0, 9 + round, 5 + point * 5),
            operator: operators[(stepIndex + round) % operators.length],
            createdAt: stamp,
            revision: ROW_REVISION,
          });
        }
      }
    });
  });

  await db.transaction(
    'rw',
    [
      db.bridges,
      db.piers,
      db.bearings,
      db.steps,
      db.readings,
      db.acceptances,
      db.points,
      db.fieldOrphans,
      db.importBatches,
      db.fieldDrafts,
    ],
    async () => {
      await db.bridges.bulkPut(bridges);
      await db.piers.bulkPut(piers);
      await db.bearings.bulkPut(bearings);
      await db.steps.bulkPut(steps);
      await db.points.bulkPut(points);
      await db.readings.bulkPut(readings);
      await db.acceptances.bulkPut(acceptances);
    },
  );
}

/* ============================== 初始化 ============================== */

/** 打开数据库；桥梁表为空时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  const count = await db.bridges.count();
  if (count === 0) {
    await seedDatabase();
  }
}

/* ============================== 桥梁 ============================== */

export async function listBridges(): Promise<BridgeRow[]> {
  return db.bridges.toArray();
}

export async function putBridge(row: BridgeRow): Promise<void> {
  await db.bridges.put(row);
}

/** 删除桥梁并级联清理墩台 / 支座 / 步骤 / 读数 / 验收 / 测点；
 *  待复核记录与导入检查点保留（归档追溯来源），仅随整库重置清理 */
export async function removeBridge(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.bridges, db.piers, db.bearings, db.steps, db.readings, db.acceptances, db.points],
    async () => {
      const piers = await db.piers.where('bridgeId').equals(id).toArray();
      const pierIds = piers.map((item) => item.id);
      const bearingRows = pierIds.length ? await db.bearings.where('pierId').anyOf(pierIds).toArray() : [];
      const bearingIds = bearingRows.map((item) => item.id);
      const stepRows = await db.steps.where('bridgeId').equals(id).toArray();
      const stepIds = stepRows.map((item) => item.id);
      if (bearingIds.length) await db.acceptances.where('bearingId').anyOf(bearingIds).delete();
      if (stepIds.length) {
        await db.readings.where('stepId').anyOf(stepIds).delete();
        await db.points.where('stepId').anyOf(stepIds).delete();
      }
      await db.steps.where('bridgeId').equals(id).delete();
      if (pierIds.length) await db.bearings.where('pierId').anyOf(pierIds).delete();
      await db.piers.where('bridgeId').equals(id).delete();
      await db.bridges.delete(id);
    },
  );
}

/* ============================== 墩台 ============================== */

export async function listPiers(): Promise<PierRow[]> {
  return db.piers.toArray();
}

export async function putPier(row: PierRow): Promise<void> {
  await db.piers.put(row);
}

export async function removePier(id: string): Promise<void> {
  await db.transaction('rw', [db.piers, db.bearings, db.acceptances], async () => {
    const bearingRows = await db.bearings.where('pierId').equals(id).toArray();
    const bearingIds = bearingRows.map((item) => item.id);
    if (bearingIds.length) await db.acceptances.where('bearingId').anyOf(bearingIds).delete();
    await db.bearings.where('pierId').equals(id).delete();
    await db.piers.delete(id);
  });
}

/* ============================== 支座 ============================== */

export async function listBearings(): Promise<BearingRow[]> {
  return db.bearings.toArray();
}

export async function putBearing(row: BearingRow): Promise<void> {
  await db.bearings.put(row);
}

export async function putBearings(rows: BearingRow[]): Promise<void> {
  await db.bearings.bulkPut(rows);
}

export async function removeBearing(id: string): Promise<void> {
  await db.transaction('rw', [db.bearings, db.acceptances], async () => {
    await db.acceptances.where('bearingId').equals(id).delete();
    await db.bearings.delete(id);
  });
}

/* ============================ 顶升步骤 ============================ */

export async function listSteps(): Promise<StepRow[]> {
  const rows = await db.steps.toArray();
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function putStep(row: StepRow): Promise<void> {
  await db.steps.put(row);
}

export async function putSteps(rows: StepRow[]): Promise<void> {
  await db.steps.bulkPut(rows);
}

export async function removeStep(id: string): Promise<void> {
  await db.transaction('rw', [db.steps, db.readings, db.points], async () => {
    await db.readings.where('stepId').equals(id).delete();
    await db.points.where('stepId').equals(id).delete();
    await db.steps.delete(id);
  });
}

/* ============================ 测点布设计划 ============================ */

export async function listPoints(): Promise<PointDbRow[]> {
  const rows = await db.points.toArray();
  return rows.sort((a, b) => a.stepId.localeCompare(b.stepId) || a.pointCode.localeCompare(b.pointCode));
}

export async function putPoint(row: PointDbRow): Promise<void> {
  await db.points.put(row);
}

export async function putPoints(rows: PointDbRow[]): Promise<void> {
  await db.points.bulkPut(rows);
}

/** 取或建测点（主台账手动录入与现场包导入共用），返回当前行 */
export async function ensurePoint(stepId: string, pointCode: string, createdByPackageId?: string): Promise<PointDbRow> {
  const id = pointIdOf(stepId, pointCode);
  const existing = await db.points.get(id);
  if (existing) return existing;
  const row: PointDbRow = {
    id,
    stepId,
    pointCode,
    active: 1,
    createdAt: new Date().toISOString(),
    ...(createdByPackageId ? { createdByPackageId } : {}),
  };
  await db.points.put(row);
  return row;
}

/** 撤去 / 恢复测点（软删：历史读数保留） */
export async function setPointActive(id: string, active: boolean): Promise<void> {
  const existing = await db.points.get(id);
  if (!existing) return;
  await db.points.put({ ...existing, active: active ? 1 : 0 });
}

/* ====================== 现场待复核 / 批次 / 草稿 ====================== */

export async function listFieldOrphans(): Promise<FieldOrphanDbRow[]> {
  return db.fieldOrphans.toArray();
}

export async function putFieldOrphan(row: FieldOrphanDbRow): Promise<void> {
  await db.fieldOrphans.put(row);
}

export async function updateFieldOrphan(id: string, patch: Partial<FieldOrphanDbRow>): Promise<void> {
  const existing = await db.fieldOrphans.get(id);
  if (!existing) return;
  await db.fieldOrphans.put({ ...existing, ...patch });
}

export async function listImportBatches(): Promise<FieldImportBatchDbRow[]> {
  const rows = await db.importBatches.toArray();
  return rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}

export async function getImportBatch(packageId: string): Promise<FieldImportBatchDbRow | undefined> {
  return db.importBatches.get(packageId);
}

export async function putImportBatch(row: FieldImportBatchDbRow): Promise<void> {
  await db.importBatches.put(row);
}

export async function listFieldDrafts(): Promise<FieldDraftDbRow[]> {
  const rows = await db.fieldDrafts.toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getFieldDraft(packageId: string): Promise<FieldDraftDbRow | undefined> {
  return db.fieldDrafts.get(packageId);
}

export async function putFieldDraft(row: FieldDraftDbRow): Promise<void> {
  await db.fieldDrafts.put(row);
}

export async function removeFieldDraft(packageId: string): Promise<void> {
  await db.fieldDrafts.delete(packageId);
}

/* ============================ 测点读数 ============================ */

export async function listReadings(): Promise<ReadingRow[]> {
  return db.readings.toArray();
}

export async function putReading(row: ReadingRow): Promise<void> {
  await db.readings.put(row);
}

export async function putReadings(rows: ReadingRow[]): Promise<void> {
  await db.readings.bulkPut(rows);
}

export async function removeReading(id: string): Promise<void> {
  await db.readings.delete(id);
}

/* ============================= 验收 ============================= */

export async function listAcceptances(): Promise<AcceptanceRow[]> {
  return db.acceptances.toArray();
}

export async function putAcceptance(row: AcceptanceRow): Promise<void> {
  await db.acceptances.put(row);
}

export async function removeAcceptance(id: string): Promise<void> {
  await db.acceptances.delete(id);
}

/* ========================== 整库导入导出 ========================== */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  bridges: Bridge[];
  piers: Pier[];
  bearings: Bearing[];
  steps: Step[];
  readings: Reading[];
  acceptances: Acceptance[];
  /** 以下为 v3 增补字段：旧备份缺失时按空数组处理 */
  points?: PointDbRow[];
  fieldOrphans?: FieldOrphanDbRow[];
  importBatches?: FieldImportBatchDbRow[];
  fieldDrafts?: FieldDraftDbRow[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [bridges, piers, bearings, steps, readings, acceptances, points, fieldOrphans, importBatches, fieldDrafts] =
    await Promise.all([
      listBridges(),
      listPiers(),
      listBearings(),
      listSteps(),
      listReadings(),
      listAcceptances(),
      listPoints(),
      listFieldOrphans(),
      listImportBatches(),
      listFieldDrafts(),
    ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bridges,
    piers,
    bearings,
    steps,
    readings,
    acceptances,
    points,
    fieldOrphans,
    importBatches,
    fieldDrafts,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.bridges,
      db.piers,
      db.bearings,
      db.steps,
      db.readings,
      db.acceptances,
      db.points,
      db.fieldOrphans,
      db.importBatches,
      db.fieldDrafts,
    ],
    async () => {
      await Promise.all([
        db.bridges.clear(),
        db.piers.clear(),
        db.bearings.clear(),
        db.steps.clear(),
        db.readings.clear(),
        db.acceptances.clear(),
        db.points.clear(),
        db.fieldOrphans.clear(),
        db.importBatches.clear(),
        db.fieldDrafts.clear(),
      ]);
      await db.bridges.bulkPut(snapshot.bridges ?? []);
      await db.piers.bulkPut(snapshot.piers ?? []);
      await db.bearings.bulkPut(snapshot.bearings ?? []);
      await db.steps.bulkPut(snapshot.steps ?? []);
      await db.readings.bulkPut(snapshot.readings ?? []);
      await db.acceptances.bulkPut(snapshot.acceptances ?? []);
      // 兼容 v2 旧备份：没有测点表时按现有读数反推补登
      const points =
        snapshot.points ??
        (snapshot.readings ?? []).map((reading) => ({
          id: reading.pointId ?? pointIdOf(reading.stepId, reading.pointCode),
          stepId: reading.stepId,
          pointCode: reading.pointCode,
          active: 1,
          createdAt: reading.createdAt,
        }));
      await db.points.bulkPut(points);
      await db.fieldOrphans.bulkPut(snapshot.fieldOrphans ?? []);
      await db.importBatches.bulkPut(snapshot.importBatches ?? []);
      await db.fieldDrafts.bulkPut(snapshot.fieldDrafts ?? []);
    },
  );
}

/** 清空并重新播种 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.bridges,
      db.piers,
      db.bearings,
      db.steps,
      db.readings,
      db.acceptances,
      db.points,
      db.fieldOrphans,
      db.importBatches,
      db.fieldDrafts,
    ],
    async () => {
      await Promise.all([
        db.bridges.clear(),
        db.piers.clear(),
        db.bearings.clear(),
        db.steps.clear(),
        db.readings.clear(),
        db.acceptances.clear(),
        db.points.clear(),
        db.fieldOrphans.clear(),
        db.importBatches.clear(),
        db.fieldDrafts.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [bridges, piers, bearings, steps, readings, acceptances, points, fieldOrphans, importBatches, fieldDrafts] =
    await Promise.all([
      db.bridges.count(),
      db.piers.count(),
      db.bearings.count(),
      db.steps.count(),
      db.readings.count(),
      db.acceptances.count(),
      db.points.count(),
      db.fieldOrphans.count(),
      db.importBatches.count(),
      db.fieldDrafts.count(),
    ]);
  return { bridges, piers, bearings, steps, readings, acceptances, points, fieldOrphans, importBatches, fieldDrafts };
}

/** 结构版本信息 */
export interface SchemaInfo {
  dbName: string;
  schemaVersion: number;
  rowRevision: number;
  today: string;
}

export function schemaInfo(): SchemaInfo {
  const now = new Date();
  return {
    dbName: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    rowRevision: ROW_REVISION,
    today: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  };
}

/** 新建行通用字段 */
export function rowMeta(): { createdAt: string; revision: number } {
  return { createdAt: new Date().toISOString(), revision: ROW_REVISION };
}

/** 新建本地 id */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
