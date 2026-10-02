/**
 * 现场包（离线作业包）领域类型
 * - 主台账（桥梁 / 墩台 / 支座 / 步骤顺序 / 测点台账）归属项目部
 * - 现场包只携带“执行事实”：步骤状态、测点读数、分步验收
 * - 挂接一律以发放时的稳定编号（实体 id / 测点 id）为准，不使用步骤序号
 */
import type { RowMeta } from './persistence';
import type { Bridge } from './bridge';
import type { Pier } from './pier';
import type { Bearing } from './bearing';
import type { Step, StepState } from './step';
import type { Reading } from './reading';
import type { Acceptance, AcceptanceConclusion, AcceptanceStage } from './acceptance';

/** 现场包文件格式标识 */
export const FIELD_PACKAGE_KIND = 'gbbridgebear-field-package';

/** 现场包结构版本 */
export const FIELD_PACKAGE_VERSION = 1;

/** 执行事实种类 */
export type FieldFactKind = 'stepState' | 'reading' | 'acceptance';

export const FIELD_FACT_KIND_LABEL: Record<FieldFactKind, string> = {
  stepState: '步骤状态',
  reading: '测点读数',
  acceptance: '分步验收',
};

/** 步骤状态事实（现场登记某步骤推进到的状态） */
export interface StepStateFact {
  kind: 'stepState';
  factId: string;
  /** 发放包时主台账步骤的稳定编号（不随调序改变） */
  stepId: string;
  /** 发放时序号，仅用于现场人工核对，不用于挂接 */
  issuedSeq: number;
  state: StepState;
  recordedAt: string;
  operator: string;
  note: string;
}

/** 测点读数事实 */
export interface ReadingFact {
  kind: 'reading';
  factId: string;
  stepId: string;
  issuedSeq: number;
  /** 测点稳定编号（主台账测点台账的 id）；找不到归属即进待复核区 */
  pointId: string;
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
  recordedAt: string;
  operator: string;
}

/** 分步验收事实 */
export interface AcceptanceFact {
  kind: 'acceptance';
  factId: string;
  bearingId: string;
  /** 发放时支座的人工坐标（墩台编号 + 序号），仅用于现场核对 */
  issuedBearingLabel: string;
  stage: AcceptanceStage;
  conclusion: AcceptanceConclusion;
  acceptor: string;
  acceptedAt: string;
  note: string;
}

export type FieldFact = StepStateFact | ReadingFact | AcceptanceFact;

/** 发放时的步骤快照（稳定编号 + 顺序，供现场展示与回项目部核对） */
export interface IssuedStep {
  id: string;
  seq: number;
  targetLiftMm: number;
  syncRequirement: Step['syncRequirement'];
  limitMm: number;
  leader: string;
  state: StepState;
}

/** 发放时的测点台账快照 */
export interface IssuedPoint {
  id: string;
  stepId: string;
  pointCode: string;
  location: string;
}

/** 发放时的支座快照 */
export interface IssuedBearing {
  id: string;
  pierId: string;
  pierCode: string;
  serial: string;
  spec: string;
}

/**
 * 现场离线作业包：
 * manifest 描述发放信息；context 是发放瞬间的主台账只读快照；
 * facts 为平板登记的执行事实。
 */
export interface FieldPackage {
  kind: typeof FIELD_PACKAGE_KIND;
  packageVersion: number;
  /** 每次发放唯一，幂等键 */
  packageId: string;
  issuedAt: string;
  issuedBy: string;
  /** 发放的主台账结构版本 */
  schemaVersion: number;
  bridge: Pick<Bridge, 'id' | 'name'>;
  context: {
    piers: Array<Pick<Pier, 'id' | 'bridgeId' | 'code' | 'type'>>;
    bearings: IssuedBearing[];
    steps: IssuedStep[];
    points: IssuedPoint[];
  };
  facts: FieldFact[];
  /** 现场作业设备 / 班组说明 */
  deviceTag: string;
  /** 封包时间（未封包为空串，表示还在登记中） */
  sealedAt: string;
}

/** 包内事实计数 */
export function countFacts(facts: FieldFact[]): { stepStates: number; readings: number; acceptances: number } {
  return {
    stepStates: facts.filter((item) => item.kind === 'stepState').length,
    readings: facts.filter((item) => item.kind === 'reading').length,
    acceptances: facts.filter((item) => item.kind === 'acceptance').length,
  };
}

/** 判定目标 JSON 是否为现场包 */
export function isFieldPackage(value: unknown): value is FieldPackage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FieldPackage>;
  return (
    candidate.kind === FIELD_PACKAGE_KIND &&
    typeof candidate.packageId === 'string' &&
    !!candidate.bridge &&
    typeof (candidate as { bridge?: unknown }).bridge === 'object' &&
    Array.isArray(candidate.facts) &&
    !!candidate.context &&
    Array.isArray((candidate.context as { points?: unknown }).points)
  );
}

/** 现场包导出文件名 */
export function fieldPackageFilename(pkg: Pick<FieldPackage, 'bridge' | 'sealedAt' | 'packageId'>): string {
  const date = (pkg.sealedAt || new Date().toISOString()).slice(0, 10).replace(/-/g, '');
  const shortId = pkg.packageId.slice(0, 8);
  return `field-${pkg.bridge.name}-${date}-${shortId}.json`;
}

/** 事实在待复核区内的展示标签（统一提取关键字段，供 UI 使用） */
export function factSummary(fact: FieldFact): string {
  if (fact.kind === 'stepState') {
    return `第 ${fact.issuedSeq} 级 → ${fact.state}（${fact.recordedAt}，${fact.operator}）`;
  }
  if (fact.kind === 'reading') {
    return `${fact.pointCode} 位移 ${fact.displacementMm} mm / 应力 ${fact.stressMpa} MPa（${fact.recordedAt}，${fact.operator}）`;
  }
  return `${fact.stage} 验收 ${fact.conclusion}（${fact.acceptedAt}，${fact.acceptor}）`;
}

export type { Bridge, Pier, Bearing, Step, Reading, Acceptance };
