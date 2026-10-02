/**
 * 离线合并领域类型：待复核记录、导入批次 / 检查点、合并报告。
 * 主台账始终是归属方：找不到归属的现场事实进待复核区并指出来源，
 * 处理前不放行整座桥归档。
 */
import type { RowMeta } from './persistence';
import type { FieldFact, FieldFactKind } from './field-package';
import type { Bridge } from './bridge';
import type { StepState } from './step';

/** 待复核原因（主台账相对发放包发生了变化） */
export type ReviewReason =
  | 'step-missing' // 主台账已无该步骤
  | 'bearing-missing' // 主台账已替换 / 删除该支座
  | 'point-missing' // 主台账已撤去该测点
  | 'bridge-missing'; // 主台账已无该桥梁

export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  'step-missing': '步骤已从主台账移除（可能重排或删改）',
  'bearing-missing': '支座已在主台账替换或删除',
  'point-missing': '测点已从主台账撤去',
  'bridge-missing': '主台账找不到该桥梁',
};

/** 待复核记录状态 */
export type ReviewStatus = 'open' | 'resolved';

/**
 * 待复核记录：保留原始事实，并指出来源包、来源桥梁。
 * payload 是现场事实的只读快照，处理后不回写事实本身。
 */
export interface ReviewItem extends RowMeta {
  id: string;
  status: ReviewStatus;
  reason: ReviewReason;
  factKind: FieldFactKind;
  /** 来源现场包 id */
  sourcePackageId: string;
  /** 来源现场包封包时间 */
  sourceSealedAt: string;
  /** 来源桥梁 id / 名称（桥梁可能已删除，名称留档） */
  bridgeId: string;
  bridgeName: string;
  /** 原始现场事实 */
  payload: FieldFact;
  /** 处理说明（人工核对结果） */
  resolution: string;
  resolvedAt: string;
}

/** 导入检查点状态 */
export type ImportCheckpointStatus = 'pending' | 'applied' | 'abandoned';

/**
 * 导入检查点：
 * - 失败时保留原始包与试合并报告，可直接重试；
 * - applied 后保留摘要，同一包再次导入直接判定为已应用（幂等）。
 */
export interface ImportCheckpoint extends RowMeta {
  id: string;
  packageId: string;
  bridgeId: string;
  bridgeName: string;
  status: ImportCheckpointStatus;
  /** 最近一次动作时间 */
  attemptedAt: string;
  /** 失败原因（status=pending 时有值） */
  lastError: string;
  /** 失败次数，便于提示 */
  attempts: number;
  /** 已应用的合并报告（试合并 / 正式合并同结构） */
  report: MergeReport | null;
  /** 原始现场包（检查点保留，供重试；applied 时也保留以便追溯） */
  pkgJson: string;
}

/** 单条事实的合并处置 */
export type MergeOutcome =
  | 'applied' // 已写入主台账
  | 'skipped-duplicate-fact' // 同一 factId 已导入过
  | 'skipped-package-sealed' // 同包已应用，整包跳过
  | 'review'; // 找不到归属，转待复核

export const MERGE_OUTCOME_LABEL: Record<MergeOutcome, string> = {
  applied: '已挂接',
  'skipped-duplicate-fact': '重复事实跳过',
  'skipped-package-sealed': '整包已导入',
  review: '转待复核',
};

/** 事实级合并明细 */
export interface MergeEntry {
  factId: string;
  factKind: FieldFactKind;
  outcome: MergeOutcome;
  reason: ReviewReason | null;
  /** 挂接到的主台账对象说明，如 步骤#2 / 支座 1#墩-2 / 测点 P1 */
  target: string;
  detail: string;
}

/** 一次合并的完整报告（试合并与正式合并通用） */
export interface MergeReport {
  packageId: string;
  bridgeId: string;
  bridgeName: string;
  appliedAt: string;
  /** 真正写入的读数 / 验收 / 步骤状态条数 */
  readingsApplied: number;
  acceptancesApplied: number;
  stepStatesApplied: number;
  /** 幂等跳过 */
  duplicateFacts: number;
  /** 转待复核条数 */
  reviewCreated: number;
  blockedBridge: boolean;
  entries: MergeEntry[];
}

/** 合并前的主台账归属索引（纯函数试算用） */
export interface MergeContextIndex {
  bridges: Bridge[];
  stepIds: Set<string>;
  bearingIds: Set<string>;
  pointIds: Set<string>;
  /** 已落账事实 id（field_facts 表） */
  appliedFactIds: Set<string>;
  /** 已封包导入过的现场包 id */
  sealedPackageIds: Set<string>;
}

/** 正式合并要写入主台账的行（id 在落账事务内生成，保证失败重试不产生固定 id） */
export interface MergeWrites {
  stepStates: Array<{ stepId: string; state: StepState; factId: string }>;
  readings: Array<{ factId: string; fact: Extract<FieldFact, { kind: 'reading' }> }>;
  acceptances: Array<{ factId: string; fact: Extract<FieldFact, { kind: 'acceptance' }> }>;
}

/** 试算结果：报告 + 待复核行 + 正式合并时要写入的行 */
export interface MergePlan {
  report: MergeReport;
  reviewItems: ReviewItem[];
  writes: MergeWrites;
}
