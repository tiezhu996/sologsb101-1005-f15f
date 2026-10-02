/**
 * 归档判定辅助：检查是否所有支座均已完成四步验收，且没有未处理的待复核现场记录。
 * 找不到归属的现场事实未处理前，不放行整座桥归档。
 * 被 acceptance store 的批量签署 effect 与验收页归档动作调用。
 */
import {
  listAcceptances,
  listBearings,
  listBridges,
  listPiers,
  listReadings,
  listReviewItems,
  listSteps,
} from '../utils/db';
import { ACCEPTANCE_STAGES, archiveSummary } from '../types/acceptance';

export interface ArchiveCheckResult {
  /** 已满足归档条件的桥梁 id */
  archivableBridgeIds: string[];
  /** 摘要文案 */
  summaries: string[];
  /** 因待复核未处理而被拦截的桥梁 id → 未处理条数 */
  blockedByReview: Array<{ bridgeId: string; bridgeName: string; openCount: number }>;
}

/** 检查全部桥梁的归档条件 */
export async function checkBridgeArchived(): Promise<ArchiveCheckResult> {
  const [bridges, piers, bearings, acceptances, steps, readings, reviewItems] = await Promise.all([
    listBridges(),
    listPiers(),
    listBearings(),
    listAcceptances(),
    listSteps(),
    listReadings(),
    listReviewItems(),
  ]);

  const openReviewByBridge = new Map<string, number>();
  for (const item of reviewItems) {
    if (item.status !== 'open') continue;
    openReviewByBridge.set(item.bridgeId, (openReviewByBridge.get(item.bridgeId) ?? 0) + 1);
  }

  const archivableBridgeIds: string[] = [];
  const summaries: string[] = [];
  const blockedByReview: ArchiveCheckResult['blockedByReview'] = [];

  for (const bridge of bridges) {
    const openCount = openReviewByBridge.get(bridge.id) ?? 0;
    if (openCount > 0) {
      blockedByReview.push({ bridgeId: bridge.id, bridgeName: bridge.name, openCount });
      continue;
    }

    const pierIds = new Set(piers.filter((item) => item.bridgeId === bridge.id).map((item) => item.id));
    const ownedBearings = bearings.filter((item) => pierIds.has(item.pierId));
    if (ownedBearings.length === 0) continue;
    const fullyAccepted = ownedBearings.filter((bearing) => {
      const passed = new Set(
        acceptances
          .filter((item) => item.bearingId === bearing.id && item.conclusion === 'pass')
          .map((item) => item.stage),
      );
      const failed = acceptances.some((item) => item.bearingId === bearing.id && item.conclusion === 'fail');
      return !failed && ACCEPTANCE_STAGES.every((stage) => passed.has(stage));
    });
    if (fullyAccepted.length < ownedBearings.length) continue;

    const bridgeSteps = steps.filter((item) => item.bridgeId === bridge.id);
    const stepIds = new Set(bridgeSteps.map((item) => item.id));
    archivableBridgeIds.push(bridge.id);
    summaries.push(
      archiveSummary({
        bridgeName: bridge.name,
        bearingCount: ownedBearings.length,
        totalLiftMm: Number(bridgeSteps.reduce((sum, item) => sum + item.targetLiftMm, 0).toFixed(2)),
        stepCount: bridgeSteps.length,
        readingCount: readings.filter((item) => stepIds.has(item.stepId)).length,
      }),
    );
  }

  return { archivableBridgeIds, summaries, blockedByReview };
}
