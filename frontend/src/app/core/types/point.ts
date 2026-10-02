import type { RowMeta } from './persistence';

/** 测点状态：在用 / 已撤去（撤去后新读数无法挂接，但历史读数保留） */
export type PointStatus = 'active' | 'retired';

export const POINT_STATUS_LABEL: Record<PointStatus, string> = {
  active: '在用',
  retired: '已撤去',
};

/**
 * 测点台账：挂接单元归属主台账，现场读数按测点稳定 id 挂接，
 * 撤去测点不会删除历史读数，只令后续现场事实落入待复核区。
 */
export interface MonitorPoint extends RowMeta {
  id: string;
  /** 所属顶升步骤（步骤的稳定 id） */
  stepId: string;
  /** 测点编号，如 P1、J-2 */
  pointCode: string;
  /** 布置位置说明，如 大里程左侧 */
  location: string;
  status: PointStatus;
}

/** 测点表单草稿 */
export interface MonitorPointDraft {
  stepId: string;
  pointCode: string;
  location: string;
}

/** 测点视图：带步骤与桥梁上下文 */
export interface MonitorPointView extends MonitorPoint {
  stepSeq: number;
  bridgeId: string;
  bridgeName: string;
  readingCount: number;
}

/** 同步顶升默认四角测点编号 */
export const DEFAULT_POINT_CODES = ['P1', 'P2', 'P3', 'P4'];

/** 按同步要求生成默认测点（单点只布置 1 个，其余四角） */
export function defaultPointsFor(syncRequirement: 'sync' | 'cross' | 'single'): string[] {
  return syncRequirement === 'single' ? ['P1'] : [...DEFAULT_POINT_CODES];
}
