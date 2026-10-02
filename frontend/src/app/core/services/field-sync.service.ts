/**
 * 现场作业服务：项目部「发放包」与平板「断网登记—回填导出」的编排层。
 * - loadPackageFromFile：平板载入发放包 JSON，生成 / 复用本地登记草稿（fieldDrafts 表，断网可录）；
 * - saveDraft：每次登记自动落本地，不依赖网络；
 * - buildReturnedPackage：导出回填后的现场包（只含执行事实，不动锚点）；
 * - listDrafts / removeDraftAfterReturn：草稿管理。
 * 纯前端实现：发放包与回填包都通过文件传递（U 盘 / 聊天工具均可）。
 */
import { Injectable } from '@angular/core';
import {
  buildFieldPackage,
  type IssuePackageInput,
} from '../utils/field-merge';
import {
  getFieldDraft,
  listFieldDrafts,
  putFieldDraft,
  removeFieldDraft,
} from '../utils/db';
import {
  FIELD_PACKAGE_KIND,
  FIELD_PACKAGE_VERSION,
  type FieldAcceptanceFact,
  type FieldDraftRow,
  type FieldPackage,
  type FieldReadingFact,
  type FieldStepFact,
} from '../types/field-package';

@Injectable({ providedIn: 'root' })
export class FieldSyncService {
  /** 项目部：发放（导出）一座桥的现场作业包 */
  async issuePackage(input: IssuePackageInput): Promise<FieldPackage> {
    return buildFieldPackage(input);
  }

  /** 平板：读入发放包；若该包已登记过则续用本地草稿 */
  async openPackage(pkg: FieldPackage, deviceCode: string): Promise<FieldDraftRow> {
    if (pkg.kind !== FIELD_PACKAGE_KIND || pkg.packageVersion !== FIELD_PACKAGE_VERSION) {
      throw new Error('不是受支持的现场作业包版本');
    }
    const existing = await getFieldDraft(pkg.packageId);
    if (existing) return existing;
    const draft: FieldDraftRow = {
      packageId: pkg.packageId,
      bridgeId: pkg.bridgeId,
      deviceCode: deviceCode || pkg.deviceCode || 'tablet-01',
      updatedAt: new Date().toISOString(),
      steps: [],
      readings: [],
      acceptances: [],
    };
    await putFieldDraft(draft);
    return draft;
  }

  async getDraft(packageId: string): Promise<FieldDraftRow | undefined> {
    return getFieldDraft(packageId);
  }

  async listDrafts(): Promise<FieldDraftRow[]> {
    return listFieldDrafts();
  }

  async saveDraft(draft: FieldDraftRow): Promise<void> {
    await putFieldDraft({ ...draft, updatedAt: new Date().toISOString() });
  }

  async removeDraft(packageId: string): Promise<void> {
    await removeFieldDraft(packageId);
  }

  /**
   * 平板：把登记草稿回填进发放包并导出。
   * 只覆盖 facts 段与 returnedAt / deviceCode，锚点（稳定编号）原样带回，供项目部挂接。
   */
  async buildReturnedPackage(pkg: FieldPackage, draft: FieldDraftRow): Promise<FieldPackage> {
    const returned: FieldPackage = {
      ...pkg,
      returnedAt: new Date().toISOString(),
      deviceCode: draft.deviceCode || pkg.deviceCode,
      facts: {
        steps: draft.steps,
        readings: draft.readings,
        acceptances: draft.acceptances,
      },
    };
    return returned;
  }

  /** 现场登记事实编号生成（平板本地）：同一事实在编辑 / 重试 / 再导入中保持稳定 */
  newStepFactId(packageId: string): string {
    return `s-${packageId.slice(-6)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  newReadingFactId(packageId: string): string {
    return `r-${packageId.slice(-6)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  newAcceptanceFactId(packageId: string): string {
    return `a-${packageId.slice(-6)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /** 草稿内步骤事实（每步骤保留最新一条状态事实） */
  upsertStepFact(draft: FieldDraftRow, fact: FieldStepFact): FieldDraftRow {
    const others = draft.steps.filter((item) => item.stepId !== fact.stepId);
    return { ...draft, steps: [...others, fact] };
  }

  upsertReadingFact(draft: FieldDraftRow, fact: FieldReadingFact): FieldDraftRow {
    const others = draft.readings.filter((item) => item.factId !== fact.factId);
    return { ...draft, readings: [...others, fact] };
  }

  upsertAcceptanceFact(draft: FieldDraftRow, fact: FieldAcceptanceFact): FieldDraftRow {
    // 同支座同阶段只保留最新结论
    const others = draft.acceptances.filter(
      (item) => !(item.bearingId === fact.bearingId && item.stage === fact.stage),
    );
    return { ...draft, acceptances: [...others, fact] };
  }
}
