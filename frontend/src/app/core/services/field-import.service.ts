/**
 * 现场包导入服务：检查点编排。
 * - preview：选包后先试合并（dry-run），不落账，展示挂接 / 待复核 / 幂等明细；
 * - apply：正式落账并写检查点；任何失败都保留检查点（pending）与原始包，可重试；
 * - 同一包再次导入：已 applied 的检查点直接返回既有报告，不重复生成读数 / 验收。
 */
import { Injectable } from '@angular/core';
import {
  buildMergeContextIndex,
  applyFieldPackageMerge,
  planFieldPackageMerge,
} from '../utils/merge.engine';
import {
  getImportCheckpoint,
  getImportCheckpointById,
  putImportCheckpoint,
  putFieldPackageRecord,
  removeFieldPackageRecord,
  rowMeta,
  newId,
} from '../utils/db';
import type { ImportCheckpointRow } from '../utils/db';
import type { FieldPackage } from '../types/field-package';
import type { MergePlan, MergeReport } from '../types/merge';

@Injectable({ providedIn: 'root' })
export class FieldImportService {
  /** 试合并：返回计划（不落账）；已应用的包直接给出“整包跳过”报告 */
  async preview(pkg: FieldPackage): Promise<{ plan: MergePlan; alreadyApplied: boolean }> {
    const existing = await getImportCheckpoint(pkg.packageId);
    const index = await buildMergeContextIndex();
    const plan = planFieldPackageMerge(pkg, index);
    return { plan, alreadyApplied: existing?.status === 'applied' };
  }

  /**
   * 正式导入。
   * 成功：upsert 检查点为 applied；若平板草稿留在本机则清除。
   * 失败：upsert 检查点为 pending（attempts 累加），保留 pkgJson 供重试。
   */
  async apply(pkg: FieldPackage): Promise<{ report: MergeReport; status: ImportCheckpointRow['status'] }> {
    const existing = await getImportCheckpoint(pkg.packageId);

    // 幂等：同一包已成功导入，直接返回既有报告
    if (existing?.status === 'applied' && existing.report) {
      return { report: existing.report, status: 'applied' };
    }

    try {
      // 每次都基于最新主台账重新试算，支持“修复主台账后重试”
      const index = await buildMergeContextIndex();
      const plan = planFieldPackageMerge(pkg, index);
      const report = await applyFieldPackageMerge(pkg, plan);

      const checkpoint: ImportCheckpointRow = {
        id: existing?.id ?? newId('cp'),
        packageId: pkg.packageId,
        bridgeId: pkg.bridge.id,
        bridgeName: pkg.bridge.name,
        status: 'applied',
        attemptedAt: new Date().toISOString(),
        lastError: '',
        attempts: (existing?.attempts ?? 0) + 1,
        report,
        pkgJson: JSON.stringify(pkg),
        ...rowMeta(),
      };
      await putImportCheckpoint(checkpoint);
      await removeFieldPackageRecord(pkg.packageId);
      return { report, status: 'applied' };
    } catch (error) {
      const checkpoint: ImportCheckpointRow = {
        id: existing?.id ?? newId('cp'),
        packageId: pkg.packageId,
        bridgeId: pkg.bridge.id,
        bridgeName: pkg.bridge.name,
        status: 'pending',
        attemptedAt: new Date().toISOString(),
        lastError: error instanceof Error ? error.message : '合并事务异常',
        attempts: (existing?.attempts ?? 0) + 1,
        report: existing?.report ?? null,
        pkgJson: JSON.stringify(pkg),
        ...rowMeta(),
      };
      await putImportCheckpoint(checkpoint);
      throw error;
    }
  }

  /** 从检查点重试（原始包原样重放，幂等保证不重复） */
  async retry(checkpointId: string): Promise<{ report: MergeReport; status: ImportCheckpointRow['status'] }> {
    const checkpoint = await getImportCheckpointById(checkpointId);
    if (!checkpoint) throw new Error('检查点不存在或已清理');
    const pkg = JSON.parse(checkpoint.pkgJson) as FieldPackage;
    return this.apply(pkg);
  }

  /** 放弃检查点（标记 abandoned，保留留档但不再提示重试） */
  async abandon(checkpointId: string): Promise<void> {
    const checkpoint = await getImportCheckpointById(checkpointId);
    if (!checkpoint) return;
    await putImportCheckpoint({ ...checkpoint, status: 'abandoned', attemptedAt: new Date().toISOString() });
  }

  /** 平板封包后在本机留一份草稿记录（便于查看已封包清单） */
  async saveSealedDraft(pkg: FieldPackage): Promise<void> {
    await putFieldPackageRecord({
      packageId: pkg.packageId,
      bridgeId: pkg.bridge.id,
      status: 'sealed',
      updatedAt: new Date().toISOString(),
      pkg,
    });
  }
}
