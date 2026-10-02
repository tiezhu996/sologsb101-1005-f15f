/**
 * 现场作业包（field package）领域模型。
 *
 * 角色划分：
 * - 主台账（项目部）是桥梁、墩台、支座、步骤顺序、测点布设计划的归属方；
 * - 现场包只携带「执行事实」——步骤推进状态、测点读数、分步验收，不回写台账结构。
 *
 * 挂接规则（核心）：
 * - 导入一律按发放时写入包内的稳定编号（stepId / bearingId / pointId）重新挂接，
 *   绝不按步骤序号 seq 硬套：主台账重排步骤顺序不影响现场读数落位。
 * - 主台账替换支座（旧 bearingId 消失）或撤去测点（pointId 停用）时，
 *   找不到归属的现场事实进入待复核区（fieldOrphans），处理前不放行该桥归档。
 */
import type { AcceptanceStage, AcceptanceConclusion } from './acceptance';
import type { StepState } from './step';

/** 现场包格式标识与兼容版本 */
export const FIELD_PACKAGE_KIND = 'gbbridgebear-field-package';
export const FIELD_PACKAGE_VERSION = 1;

/** 现场包前缀：现场平板与主台账必须一致，才能按桥梁匹配发放包 */
export const FIELD_PACKAGE_PREFIX = 'fldpkg';

/* ============================== 现场包结构 ============================== */

/** 测点布设计划锚点（发放时快照，供平板展示；不参与主台账结构回写） */
export interface FieldPointAnchor {
  /** 测点稳定编号（主台账 points 表主键） */
  pointId: string;
  stepId: string;
  pointCode: string;
}

/** 步骤锚点：只用于平板展示顺序，seq 仅为展示，导入不作挂接依据 */
export interface FieldStepAnchor {
  stepId: string;
  seq: number;
  targetLiftMm: number;
  limitMm: number;
  state: StepState;
}

/** 支座锚点：验收事实按 bearingId 挂接 */
export interface FieldBearingAnchor {
  bearingId: string;
  pierCode: string;
  serial: string;
  spec: string;
}

/** 步骤执行事实：现场只回报状态推进结果 */
export interface FieldStepFact {
  /** 现场事实稳定编号（同一事实在包内、重试、再导入时保持不变） */
  factId: string;
  stepId: string;
  state: StepState;
  recordedAt: string;
  operator: string;
  note?: string;
}

/** 测点读数执行事实 */
export interface FieldReadingFact {
  factId: string;
  /** 挂接优先级：pointId 稳定编号 > stepId+pointCode 回退 */
  pointId?: string;
  stepId: string;
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
  recordedAt: string;
  operator: string;
}

/** 分步验收执行事实 */
export interface FieldAcceptanceFact {
  factId: string;
  bearingId: string;
  stage: AcceptanceStage;
  conclusion: AcceptanceConclusion;
  acceptor: string;
  acceptedAt: string;
}

/** 现场作业包：发放 + 回填共用同一结构 */
export interface FieldPackage {
  kind: typeof FIELD_PACKAGE_KIND;
  packageVersion: number;
  /** 包稳定编号：发放时生成，幂等键，同一包重复导入不重复落库 */
  packageId: string;
  /** 主台账桥梁稳定编号 */
  bridgeId: string;
  bridgeName: string;
  issuedAt: string;
  /** 现场回填时间（发放时为空） */
  returnedAt?: string;
  /** 现场平板标识，便于待复核记录指认来源设备 */
  deviceCode?: string;
  anchors: {
    steps: FieldStepAnchor[];
    points: FieldPointAnchor[];
    bearings: FieldBearingAnchor[];
  };
  facts: {
    steps: FieldStepFact[];
    readings: FieldReadingFact[];
    acceptances: FieldAcceptanceFact[];
  };
}

/* ============================== 测点台账 ============================== */

/**
 * 测点布设计划（主台账归属）。
 * 主台账可「撤去测点」：active=0 软删除，历史读数保留，新导入的该测点事实进待复核区。
 */
export interface PointRow {
  id: string;
  stepId: string;
  pointCode: string;
  /** 1 启用 / 0 撤去（Dexie 索引只能索引数字/字符串，布尔不入库） */
  active: number;
  /** 来源包 id：由现场包导入自动补登的测点，回指来源；主台账自建为空 */
  createdByPackageId?: string;
  createdAt: string;
}

/* ============================== 待复核区 ============================== */

export type FieldOrphanKind = 'step' | 'reading' | 'acceptance';
export type FieldOrphanReason = 'step-missing' | 'point-retired' | 'bearing-missing';
export type FieldOrphanStatus = 'pending' | 'resolved' | 'discarded';

export const FIELD_ORPHAN_KIND_LABEL: Record<FieldOrphanKind, string> = {
  step: '步骤状态',
  reading: '测点读数',
  acceptance: '分步验收',
};

export const FIELD_ORPHAN_REASON_LABEL: Record<FieldOrphanReason, string> = {
  'step-missing': '主台账找不到该步骤（步骤已删除）',
  'point-retired': '测点已被主台账撤去',
  'bearing-missing': '主台账找不到该支座（支座已替换）',
};

export const FIELD_ORPHAN_STATUS_LABEL: Record<FieldOrphanStatus, string> = {
  pending: '待复核',
  resolved: '已挂接',
  discarded: '已作废',
};

/** 找不到归属的现场事实：留在待复核区并指认来源 */
export interface FieldOrphanRow {
  id: string;
  /** 来源包稳定编号 */
  packageId: string;
  bridgeId: string;
  /** 来源设备（平板）标识 */
  deviceCode?: string;
  kind: FieldOrphanKind;
  reason: FieldOrphanReason;
  status: FieldOrphanStatus;
  /** 原始事实（原样保留，含原始稳定编号与时间，用于指认来源） */
  payload: FieldStepFact | FieldReadingFact | FieldAcceptanceFact;
  createdAt: string;
  resolvedAt?: string;
  /** 复核处理备注 */
  resolveNote?: string;
}

/* ============================== 导入批次 / 检查点 ============================== */

export type FieldImportStatus = 'succeeded' | 'failed';

/**
 * 导入批次：
 * - succeeded：该 packageId 已完整合并，再次导入直接幂等跳过；
 * - failed：检查点——保留整包原文与失败原因，可在页面上「重试」，事务保证失败不留半成品。
 */
export interface FieldImportBatchRow {
  packageId: string;
  bridgeId: string;
  bridgeName: string;
  deviceCode?: string;
  status: FieldImportStatus;
  fileName?: string;
  importedAt: string;
  error?: string;
  /** 最近一次合并报告 JSON */
  lastReport?: string;
  /** 检查点：失败时保留的整包原文（成功后也留一份便于追溯） */
  packageJson: string;
}

/* ============================== 现场登记草稿（平板本地暂存） ============================== */

/** 平板上按包暂存的登记内容（IndexedDB fieldDrafts 表，断网也可录） */
export interface FieldDraftRow {
  packageId: string;
  bridgeId: string;
  deviceCode: string;
  updatedAt: string;
  steps: FieldStepFact[];
  readings: FieldReadingFact[];
  acceptances: FieldAcceptanceFact[];
}

/* ============================== 合并报告 ============================== */

export interface FieldMergeReport {
  packageId: string;
  bridgeId: string;
  /** true 表示该包此前已成功导入，本次为幂等跳过，未新生成任何读数 / 验收 */
  duplicated: boolean;
  stepsApplied: number;
  readingsInserted: number;
  readingsSkipped: number;
  acceptancesInserted: number;
  acceptancesSkipped: number;
  pointsCreated: number;
  orphansCreated: number;
  orphanReasons: FieldOrphanReason[];
}

/* ============================== 纯函数工具 ============================== */

/** 测点稳定编号：步骤 id + 测点编号 确定性派生，主台账与平板口径一致 */
export function pointIdOf(stepId: string, pointCode: string): string {
  return `point-${stepId}-${pointCode}`;
}

/** 步骤状态权重：现场回报只允许单调推进，不允许用旧状态回退主台账 */
export function stepStateWeight(state: StepState): number {
  return state === 'idle' ? 0 : state === 'lifting' ? 1 : 2;
}

/** 现场包文件名 */
export function fieldPackageFilename(pkg: FieldPackage): string {
  const stamp = pkg.issuedAt.slice(0, 10).replace(/-/g, '');
  return `${FIELD_PACKAGE_PREFIX}-${pkg.bridgeId}-${stamp}-${pkg.packageId.slice(0, 8)}.json`;
}

/** 结构校验：不是合法现场包则给出中文原因（此类错误不建立检查点） */
export function validateFieldPackage(input: unknown): { ok: true; pkg: FieldPackage } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '文件内容不是 JSON 对象' };
  const pkg = input as Partial<FieldPackage>;
  if (pkg.kind !== FIELD_PACKAGE_KIND) {
    return { ok: false, error: `不是桥梁现场作业包（kind 应为 ${FIELD_PACKAGE_KIND}），整库备份请在验收页导入` };
  }
  if (pkg.packageVersion !== FIELD_PACKAGE_VERSION) {
    return { ok: false, error: `现场包版本 ${pkg.packageVersion ?? '未知'} 与当前 v${FIELD_PACKAGE_VERSION} 不兼容` };
  }
  if (typeof pkg.packageId !== 'string' || !pkg.packageId) return { ok: false, error: '现场包缺少 packageId 稳定编号' };
  if (typeof pkg.bridgeId !== 'string' || !pkg.bridgeId) return { ok: false, error: '现场包缺少 bridgeId 归属编号' };
  if (!pkg.anchors || !Array.isArray(pkg.anchors.steps)) return { ok: false, error: '现场包缺少 anchors.steps 锚点' };
  if (!pkg.facts) return { ok: false, error: '现场包缺少 facts 执行事实段' };
  for (const key of ['steps', 'readings', 'acceptances'] as const) {
    if (!Array.isArray(pkg.facts[key])) return { ok: false, error: `现场包 facts.${key} 不是数组` };
  }
  return { ok: true, pkg: input as FieldPackage };
}
