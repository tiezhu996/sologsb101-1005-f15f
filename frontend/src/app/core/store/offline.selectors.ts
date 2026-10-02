/**
 * 离线合并 selectors：测点视图、待复核分组、检查点列表与归档拦截。
 */
import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { OfflineState } from './offline.reducer';
import type { MonitorPointView } from '../types/point';
import type { ImportCheckpointRow, PointRow, ReviewItemRow, StepRow } from '../utils/db';
import { FIELD_FACT_KIND_LABEL } from '../types/field-package';
import { REVIEW_REASON_LABEL } from '../types/merge';

export const selectOfflineState = createFeatureSelector<OfflineState>('offline');
export const selectPoints = createSelector(selectOfflineState, (state) => state.points);
export const selectReviewItems = createSelector(selectOfflineState, (state) => state.reviewItems);
export const selectCheckpoints = createSelector(selectOfflineState, (state) => state.checkpoints);

/** 未处理待复核数（顶栏徽标） */
export const selectOpenReviewCount = createSelector(
  selectReviewItems,
  (items) => items.filter((item) => item.status === 'open').length,
);

/** 失败待重试的检查点数 */
export const selectPendingCheckpointCount = createSelector(
  selectCheckpoints,
  (items) => items.filter((item) => item.status === 'pending').length,
);

/** 存在未处理待复核记录的桥梁 id 集合 —— 归档拦截依据 */
export const selectBlockedBridgeIds = createSelector(
  selectReviewItems,
  (items) => new Set(items.filter((item) => item.status === 'open').map((item) => item.bridgeId)),
);

export function isBridgeBlocked(openItems: ReviewItemRow[], bridgeId: string): boolean {
  return openItems.some((item) => item.bridgeId === bridgeId);
}

/** 测点视图：带步骤 / 桥梁上下文与读数计数 */
export function buildPointViews(
  points: PointRow[],
  steps: StepRow[],
  bridges: Array<{ id: string; name: string }>,
  readings: Array<{ stepId: string }>,
): MonitorPointView[] {
  const stepMap = new Map(steps.map((step) => [step.id, step]));
  const bridgeName = new Map(bridges.map((bridge) => [bridge.id, bridge.name]));
  const readingCountByStep = new Map<string, number>();
  for (const reading of readings) {
    readingCountByStep.set(reading.stepId, (readingCountByStep.get(reading.stepId) ?? 0) + 1);
  }
  return points.map((point) => {
    const step = stepMap.get(point.stepId);
    const bridgeId = step?.bridgeId ?? '';
    return {
      ...point,
      stepSeq: step?.seq ?? 0,
      bridgeId,
      bridgeName: bridgeName.get(bridgeId) ?? '未归属桥梁',
      readingCount: readingCountByStep.get(point.stepId) ?? 0,
    };
  });
}

export interface ReviewView extends ReviewItemRow {
  kindLabel: string;
  reasonLabel: string;
  sourceLabel: string;
}

/** 待复核视图：补充中文标签与来源说明 */
export function buildReviewViews(items: ReviewItemRow[]): ReviewView[] {
  return items.map((item) => ({
    ...item,
    kindLabel: FIELD_FACT_KIND_LABEL[item.factKind],
    reasonLabel: REVIEW_REASON_LABEL[item.reason],
    sourceLabel: `现场包 ${item.sourcePackageId.slice(0, 13)}… · 封包 ${item.sourceSealedAt.slice(0, 10) || '未封包'}`,
  }));
}

export interface CheckpointView extends ImportCheckpointRow {
  factCount: number;
}

/** 检查点视图：补充包内事实条数 */
export function buildCheckpointViews(checkpoints: ImportCheckpointRow[]): CheckpointView[] {
  return checkpoints.map((checkpoint) => {
    let factCount = 0;
    try {
      const pkg = JSON.parse(checkpoint.pkgJson) as { facts?: unknown[] };
      factCount = Array.isArray(pkg.facts) ? pkg.facts.length : 0;
    } catch {
      factCount = 0;
    }
    return { ...checkpoint, factCount };
  });
}
