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
import type { MonitorPoint } from '../types/point';
import { defaultPointsFor } from '../types/point';
import type { FieldFact, FieldPackage } from '../types/field-package';
import type { ImportCheckpoint, ReviewItem, ReviewStatus } from '../types/merge';
import { ROW_REVISION, type Revisioned } from '../types/persistence';

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
export type PointRow = MonitorPoint;
export type ReviewItemRow = ReviewItem;
export type ImportCheckpointRow = ImportCheckpoint;

/** 已落账执行事实（幂等键为 factId） */
export interface FieldFactRecord {
  factId: string;
  packageId: string;
  bridgeId: string;
  kind: FieldFact['kind'];
  fact: FieldFact;
  appliedAt: string;
}

/** 平板端现场包草稿（断网登记期间本地保存） */
export interface FieldPackageRecord {
  packageId: string;
  bridgeId: string;
  status: 'draft' | 'sealed';
  updatedAt: string;
  pkg: FieldPackage;
}

class BridgeBearingDatabase extends Dexie {
  bridges!: Table<BridgeRow, string>;
  piers!: Table<PierRow, string>;
  bearings!: Table<BearingRow, string>;
  steps!: Table<StepRow, string>;
  readings!: Table<ReadingRow, string>;
  acceptances!: Table<AcceptanceRow, string>;
  settings!: Table<{ id: string; value: string; updatedAt: string }, string>;
  /** v3：测点台账（稳定挂接单元，支持撤去） */
  points!: Table<PointRow, string>;
  /** v3：已落账执行事实（factId 幂等） */
  fieldFacts!: Table<FieldFactRecord, string>;
  /** v3：待复核记录（找不到归属的现场事实） */
  reviewItems!: Table<ReviewItemRow, string>;
  /** v3：现场包导入检查点（失败保留 / 重试 / 幂等） */
  importCheckpoints!: Table<ImportCheckpointRow, string>;
  /** v3：平板端现场包草稿 */
  fieldPackages!: Table<FieldPackageRecord, string>;

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

    // v3：离线现场包合并
    //   points        测点台账（稳定挂接单元，支持“撤去测点”）
    //   fieldFacts    已落账执行事实（factId 幂等，重导不重复生成读数 / 验收）
    //   reviewItems   待复核记录（找不到归属的现场事实，处理前禁止整桥归档）
    //   importCheckpoints 导入检查点（失败保留、支持重试）
    //   fieldPackages 平板端现场包草稿
    this.version(DB_SCHEMA_VERSION).stores({
      points: 'id, stepId, pointCode, status, [stepId+pointCode]',
      fieldFacts: 'factId, packageId, bridgeId, kind',
      reviewItems: 'id, status, reason, factKind, sourcePackageId, bridgeId',
      importCheckpoints: 'id, packageId, bridgeId, status, attemptedAt',
      fieldPackages: 'packageId, bridgeId, status, updatedAt',
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
  const points: PointRow[] = [];
  const readings: ReadingRow[] = [];
  const acceptances: AcceptanceRow[] = [];

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

      // 测点台账：按同步要求布置稳定测点（单点 1 个，同步 / 交叉四角）
      // 未开始的步骤同样先建测点，供现场包发放；仅暂不产生读数
      const pointCodes = defaultPointsFor(stepSpec.sync);
      const pointRows = pointCodes.map((code, pointIndex) => ({
        id: `point-${stepId}-${pointIndex + 1}`,
        stepId,
        pointCode: code,
        location: `测点 ${code}`,
        status: 'active' as const,
        createdAt: stamp,
        revision: ROW_REVISION,
      }));
      points.push(...pointRows);

      // 未开始的步骤不产生读数
      if (stepSpec.state === 'idle') return;
      const pointCount = pointRows.length;
      const rounds = stepSpec.state === 'arrived' ? 3 : 2;
      for (let round = 0; round < rounds; round += 1) {
        for (let point = 0; point < pointCount; point += 1) {
          const base = stepSpec.targetLiftMm * ((round + 1) / (rounds + 1));
          const jitter = (random() - 0.5) * 1.4;
          readings.push({
            id: `read-${stepId}-${round + 1}-${point + 1}`,
            stepId,
            pointCode: pointRows[point].pointCode,
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
      db.points,
      db.readings,
      db.acceptances,
      db.fieldFacts,
      db.reviewItems,
      db.importCheckpoints,
      db.fieldPackages,
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

/** 删除桥梁并级联清理墩台 / 支座 / 步骤 / 测点 / 读数 / 验收 */
export async function removeBridge(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.bridges,
      db.piers,
      db.bearings,
      db.steps,
      db.points,
      db.readings,
      db.acceptances,
      db.fieldFacts,
    ],
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
      await db.fieldFacts.where('bridgeId').equals(id).delete();
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
  await db.transaction('rw', [db.steps, db.points, db.readings], async () => {
    await db.readings.where('stepId').equals(id).delete();
    await db.points.where('stepId').equals(id).delete();
    await db.steps.delete(id);
  });
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

/* ============================ 测点台账 ============================ */

export async function listPoints(): Promise<PointRow[]> {
  return db.points.toArray();
}

export async function putPoint(row: PointRow): Promise<void> {
  await db.points.put(row);
}

export async function putPoints(rows: PointRow[]): Promise<void> {
  await db.points.bulkPut(rows);
}

/** 撤去测点：历史读数保留，仅置状态（后续现场事实进待复核区） */
export async function retirePoint(id: string): Promise<void> {
  const existing = await db.points.get(id);
  if (existing) await db.points.put({ ...existing, status: 'retired' });
}

/** 恢复在用测点 */
export async function activatePoint(id: string): Promise<void> {
  const existing = await db.points.get(id);
  if (existing) await db.points.put({ ...existing, status: 'active' });
}

export async function removePoint(id: string): Promise<void> {
  await db.points.delete(id);
}

/* ========================== 已落账执行事实 ========================== */

export async function listFieldFactRecords(): Promise<FieldFactRecord[]> {
  return db.fieldFacts.toArray();
}

export async function putFieldFactRecord(record: FieldFactRecord): Promise<void> {
  await db.fieldFacts.put(record);
}

/* ============================ 待复核记录 ============================ */

export async function listReviewItems(): Promise<ReviewItemRow[]> {
  const rows = await db.reviewItems.toArray();
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function putReviewItem(row: ReviewItemRow): Promise<void> {
  await db.reviewItems.put(row);
}

export async function updateReviewStatus(id: string, status: ReviewStatus, resolution: string): Promise<void> {
  const existing = await db.reviewItems.get(id);
  if (!existing) return;
  await db.reviewItems.put({
    ...existing,
    status,
    resolution,
    resolvedAt: status === 'resolved' ? new Date().toISOString() : '',
  });
}

export async function removeReviewItem(id: string): Promise<void> {
  await db.reviewItems.delete(id);
}

/* ========================== 导入检查点 / 现场包草稿 ========================== */

export async function listImportCheckpoints(): Promise<ImportCheckpointRow[]> {
  const rows = await db.importCheckpoints.toArray();
  return rows.sort((a, b) => (a.attemptedAt < b.attemptedAt ? 1 : -1));
}

export async function getImportCheckpoint(packageId: string): Promise<ImportCheckpointRow | undefined> {
  return db.importCheckpoints.where('packageId').equals(packageId).first();
}

export async function getImportCheckpointById(id: string): Promise<ImportCheckpointRow | undefined> {
  return db.importCheckpoints.get(id);
}

export async function putImportCheckpoint(row: ImportCheckpointRow): Promise<void> {
  await db.importCheckpoints.put(row);
}

export async function removeImportCheckpoint(id: string): Promise<void> {
  await db.importCheckpoints.delete(id);
}

export async function listFieldPackageRecords(): Promise<FieldPackageRecord[]> {
  return db.fieldPackages.toArray();
}

export async function getFieldPackageRecord(packageId: string): Promise<FieldPackageRecord | undefined> {
  return db.fieldPackages.get(packageId);
}

export async function putFieldPackageRecord(record: FieldPackageRecord): Promise<void> {
  await db.fieldPackages.put(record);
}

export async function removeFieldPackageRecord(packageId: string): Promise<void> {
  await db.fieldPackages.delete(packageId);
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
  /** v3 起随整库备份：测点台账；旧备份文件缺省时为空数组 */
  points?: MonitorPoint[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [bridges, piers, bearings, steps, readings, acceptances, points] = await Promise.all([
    listBridges(),
    listPiers(),
    listBearings(),
    listSteps(),
    listReadings(),
    listAcceptances(),
    listPoints(),
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
      db.points,
      db.readings,
      db.acceptances,
      db.fieldFacts,
      db.reviewItems,
      db.importCheckpoints,
      db.fieldPackages,
    ],
    async () => {
      // 整库恢复：现场合并过程表一并清空，避免旧库待复核 / 检查点污染恢复后的台账
      await Promise.all([
        db.bridges.clear(),
        db.piers.clear(),
        db.bearings.clear(),
        db.steps.clear(),
        db.points.clear(),
        db.readings.clear(),
        db.acceptances.clear(),
        db.fieldFacts.clear(),
        db.reviewItems.clear(),
        db.importCheckpoints.clear(),
        db.fieldPackages.clear(),
      ]);
      await db.bridges.bulkPut(snapshot.bridges ?? []);
      await db.piers.bulkPut(snapshot.piers ?? []);
      await db.bearings.bulkPut(snapshot.bearings ?? []);
      await db.steps.bulkPut(snapshot.steps ?? []);
      await db.points.bulkPut(snapshot.points ?? []);
      await db.readings.bulkPut(snapshot.readings ?? []);
      await db.acceptances.bulkPut(snapshot.acceptances ?? []);
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
      db.points,
      db.readings,
      db.acceptances,
      db.fieldFacts,
      db.reviewItems,
      db.importCheckpoints,
      db.fieldPackages,
    ],
    async () => {
      await Promise.all([
        db.bridges.clear(),
        db.piers.clear(),
        db.bearings.clear(),
        db.steps.clear(),
        db.points.clear(),
        db.readings.clear(),
        db.acceptances.clear(),
        db.fieldFacts.clear(),
        db.reviewItems.clear(),
        db.importCheckpoints.clear(),
        db.fieldPackages.clear(),
      ]);
    },
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [bridges, piers, bearings, steps, readings, acceptances] = await Promise.all([
    db.bridges.count(),
    db.piers.count(),
    db.bearings.count(),
    db.steps.count(),
    db.readings.count(),
    db.acceptances.count(),
  ]);
  return { bridges, piers, bearings, steps, readings, acceptances };
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
