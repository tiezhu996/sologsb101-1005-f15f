/**
 * 平板现场作业服务：断网期间把现场包草稿保存在本机 IndexedDB，
 * 回项目部后封包导出 JSON。所有登记只改 facts，不动主台账快照。
 */
import { Injectable } from '@angular/core';
import {
  listFieldPackageRecords,
  putFieldPackageRecord,
  removeFieldPackageRecord,
} from '../utils/db';
import type { FieldPackageRecord } from '../utils/db';
import type { FieldPackage } from '../types/field-package';
import {
  addAcceptanceFact,
  addReadingFact,
  addStepStateFact,
  removeFact,
  sealPackage,
} from '../utils/field-package';

@Injectable({ providedIn: 'root' })
export class FieldDeskService {
  async listDrafts(): Promise<FieldPackageRecord[]> {
    const records = await listFieldPackageRecords();
    return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** 发放的新包登记为草稿 */
  async saveDraft(pkg: FieldPackage): Promise<void> {
    await putFieldPackageRecord({
      packageId: pkg.packageId,
      bridgeId: pkg.bridge.id,
      status: pkg.sealedAt ? 'sealed' : 'draft',
      updatedAt: new Date().toISOString(),
      pkg,
    });
  }

  async deleteDraft(packageId: string): Promise<void> {
    await removeFieldPackageRecord(packageId);
  }

  async recordStepState(
    pkg: FieldPackage,
    input: Parameters<typeof addStepStateFact>[1],
  ): Promise<FieldPackage> {
    const next = addStepStateFact(pkg, input);
    await this.saveDraft(next);
    return next;
  }

  async recordReading(pkg: FieldPackage, input: Parameters<typeof addReadingFact>[1]): Promise<FieldPackage> {
    const next = addReadingFact(pkg, input);
    await this.saveDraft(next);
    return next;
  }

  async recordAcceptance(
    pkg: FieldPackage,
    input: Parameters<typeof addAcceptanceFact>[1],
  ): Promise<FieldPackage> {
    const next = addAcceptanceFact(pkg, input);
    await this.saveDraft(next);
    return next;
  }

  async deleteFact(pkg: FieldPackage, factId: string): Promise<FieldPackage> {
    const next = removeFact(pkg, factId);
    await this.saveDraft(next);
    return next;
  }

  async seal(pkg: FieldPackage): Promise<FieldPackage> {
    const next = sealPackage(pkg);
    await this.saveDraft(next);
    return next;
  }
}
