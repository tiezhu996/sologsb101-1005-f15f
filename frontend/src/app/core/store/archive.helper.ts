/**
 * 归档判定辅助：检查是否所有支座均已完成四步验收，返回可归档的桥梁摘要。
 * 被 acceptance store 的批量签署 effect 调用。
 */
import { listAcceptances, listBearings, listBridges, listPiers, listReadings, listSteps } from '../utils/db';
import { ACCEPTANCE_STAGES } from '../types/acceptance';
import { archiveSummary } from '../types/acceptance';
import { bridgeIdsBlockedByOrphans } from '../utils/field-merge';

export interface ArchiveCheckResult {
  /** 已满足归档条件的桥梁 id */
  archivableBridgeIds: string[];
  /** 摘要文案 */
  summaries: string[];
}

/**
 * 检查全部桥梁的归档条件。
 * 放行规则：四步验收全合格，且不存在来源不明的现场待复核记录
 *（主台账重排步骤不影响；替换支座 / 撤去测点 / 删步骤产生的孤儿必须先处理）。
 */
export async function checkBridgeArchived(): Promise<ArchiveCheckResult> {
  const [bridges, piers, bearings, acceptances, steps, readings, blockedBridgeIds] = await Promise.all([
    listBridges(),
    listPiers(),
    listBearings(),
    listAcceptances(),
    listSteps(),
    listReadings(),
    bridgeIdsBlockedByOrphans(),
  ]);

  const archivableBridgeIds: string[] = [];
  const summaries: string[] = [];

  for (const bridge of bridges) {
    if (blockedBridgeIds.has(bridge.id)) continue;
    const pierIds = new Set(piers.filter((item) => item.bridgeId === bridge.id).map((item) => item.id));
    const ownedBearings = bearings.filter((item) => pierIds.has(item.pierId));
    if (ownedBearings.length === 0) continue;
    const fullyAccepted = ownedBearings.filter((bearing) => {
      const passed = new Set(
        acceptances
          .filter((item) => item.bearingId === bearing.id && item.conclusion === 'pass')
          .map((item) => item.stage),
      );
      const failed = acceptances.some(
        (item) => item.bearingId === bearing.id && item.conclusion === 'fail',
      );
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

  return { archivableBridgeIds, summaries };
}
