import { Component, computed, inject, signal, type Signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { selectBridges } from '../../../core/store/bridge.selectors';
import {
  buildCheckpointViews,
  buildReviewViews,
  selectBlockedBridgeIds,
  selectCheckpoints,
  selectReviewItems,
} from '../../../core/store/offline.selectors';
import { offlineActions } from '../../../core/store/offline.actions';
import type { BridgeRow } from '../../../core/utils/db';
import { FIELD_FACT_KIND_LABEL, isFieldPackage, type FieldPackage } from '../../../core/types/field-package';
import { MERGE_OUTCOME_LABEL, type MergePlan } from '../../../core/types/merge';
import { readJsonFile } from '../../../core/utils/export';
import { FieldImportService } from '../../../core/services/field-import.service';
import { IdbTableService } from '../../../core/services/idb-table.service';
import { StatBadgeComponent } from '../../../shared/components/common/stat-badge.component';
import { EmptyPanelComponent } from '../../../shared/components/common/empty-panel.component';

/**
 * /merge 离线合并中心（项目部）
 * 1) 导入现场包 JSON，先试合并预览（按稳定编号挂接，不按步骤序号硬套）；
 * 2) 正式合并；失败保留检查点，可重试，同包重导幂等不重复；
 * 3) 待复核区处理找不到归属的事实并指出来源，未处理前拦截整桥归档；
 * 4) 主台账已有内容始终保留（只新增 / 步骤状态只向前推进）。
 */
@Component({
  selector: 'app-merge-center-page',
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSnackBarModule,
    MatTabsModule,
    MatTooltipModule,
    StatBadgeComponent,
    EmptyPanelComponent,
  ],
  template: `
    <div class="page-head">
      <div>
        <h2 class="page-title">离线合并中心</h2>
        <div class="page-sub">
          回收现场包后按发放时的稳定编号重新挂接；步骤重排、支座替换、测点撤去都不影响挂接，找不到归属的事实进待复核区。
        </div>
      </div>
    </div>

    <div class="stat-grid">
      <app-stat-badge title="待复核记录" [value]="openReviews().length" suffix="条" color="#e65100" hint="处理前不放行相关桥梁归档" />
      <app-stat-badge
        title="被拦截桥梁"
        [value]="blockedBridges().length"
        suffix="座"
        color="#c62828"
        [hint]="blockedBridgeNames()"
      />
      <app-stat-badge title="失败待重试" [value]="pendingCheckpoints().length" suffix="个" color="#ef6c00" hint="检查点已保留，可一键重试" />
      <app-stat-badge title="已成功导入" [value]="appliedCheckpoints().length" suffix="包" color="#2e7d32" hint="同一包重复导入不会重复生成读数 / 验收" />
    </div>

    <mat-tab-group mat-stretch-tabs="false" class="gb-section">
      <!-- 导入与预览 -->
      <mat-tab label="导入现场包">
        <div class="gb-tab-body">
          <mat-card appearance="outlined">
            <div style="padding: 14px 16px">
              <div class="gb-card-title">选择现场包 JSON（先试合并，不落账）</div>
              <div class="gb-hint" style="margin: 8px 0">
                支持从平板导出的现场包；导入不会清空或覆盖主台账，已有的桥梁 / 墩台 / 支座 / 步骤 / 历史读数全部保留。
              </div>
              <label class="upload-label">
                <input type="file" accept="application/json" hidden (change)="onFile($event)" />
                <span mat-flat-button color="primary">
                  <mat-icon>upload_file</mat-icon>
                  选择现场包文件
                </span>
              </label>
            </div>
          </mat-card>

          @if (previewPackage(); as pkg) {
            <mat-card appearance="outlined" class="gb-section">
              <div style="padding: 14px 16px">
                <div class="gb-card-title">
                  试合并预览 · {{ pkg.bridge.name }}
                  @if (alreadyApplied()) {
                    <mat-chip class="applied-chip">该包已成功导入，重导将整包跳过</mat-chip>
                  }
                </div>
                <div class="gb-hint" style="margin-top: 4px">
                  包号 {{ pkg.packageId.slice(0, 18) }}… · 封包 {{ (pkg.sealedAt || '未封包').slice(0, 16).replace('T', ' ') }} ·
                  {{ pkg.facts.length }} 条事实
                </div>

                <div class="gb-tags" style="margin: 10px 0">
                  <mat-chip class="outcome-applied">挂接写入：状态 {{ plan()!.report.stepStatesApplied }} · 读数 {{ plan()!.report.readingsApplied }} · 验收 {{ plan()!.report.acceptancesApplied }}</mat-chip>
                  <mat-chip class="outcome-dup">幂等跳过 {{ plan()!.report.duplicateFacts }}</mat-chip>
                  <mat-chip class="outcome-review">转待复核 {{ plan()!.report.reviewCreated }}</mat-chip>
                </div>

                @if (plan()!.report.blockedBridge) {
                  <div class="block-banner">
                    <mat-icon>warning</mat-icon>
                    存在 {{ plan()!.report.reviewCreated }} 条找不到归属的事实，将进入待复核区并拦截「{{ pkg.bridge.name }}」归档，处理完成前不放行。
                  </div>
                }

                <div class="gb-table-wrap">
                  <table class="gb-table">
                    <thead>
                      <tr>
                        <th>类别</th>
                        <th>处置</th>
                        <th>挂接对象（稳定编号）</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (entry of plan()!.report.entries; track entry.factId) {
                        <tr>
                          <td>{{ FIELD_FACT_KIND_LABEL[entry.factKind] }}</td>
                          <td>
                            <mat-chip [class]="'outcome-' + outcomeClass(entry.outcome)">
                              {{ MERGE_OUTCOME_LABEL[entry.outcome] }}
                            </mat-chip>
                          </td>
                          <td class="gb-mono">{{ entry.target }}</td>
                          <td class="gb-hint">{{ entry.detail }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>

                <div class="gb-inline-actions" style="margin-top: 12px">
                  <button mat-flat-button color="primary" (click)="confirmApply()">
                    <mat-icon>merge_type</mat-icon>
                    确认正式合并
                  </button>
                  <button mat-stroked-button (click)="clearPreview()">放弃本次选择</button>
                </div>
              </div>
            </mat-card>
          }
        </div>
      </mat-tab>

      <!-- 待复核区 -->
      <mat-tab [label]="'待复核区（' + reviewViews().length + '）'">
        <div class="gb-tab-body">
          @if (reviewViews().length === 0) {
            <app-empty-panel
              title="没有待复核记录"
              description="所有现场事实都能按稳定编号挂接到主台账；导入产生的归属异常会出现在这里并拦截归档。"
              icon="rule_folder"
            />
          } @else {
            <div class="gb-table-wrap">
              <table class="gb-table">
                <thead>
                  <tr>
                    <th>状态</th>
                    <th>桥梁 / 类别</th>
                    <th>找不到归属原因</th>
                    <th>事实内容</th>
                    <th>来源现场包</th>
                    <th style="width: 300px">处理</th>
                  </tr>
                </thead>
                <tbody>
                  @for (item of reviewViews(); track item.id) {
                    <tr [class.is-open]="item.status === 'open'">
                      <td>
                        @if (item.status === 'open') {
                          <mat-chip class="outcome-review">待处理</mat-chip>
                        } @else {
                          <mat-chip class="applied-chip">已处理</mat-chip>
                        }
                      </td>
                      <td>
                        <div>{{ item.bridgeName }}</div>
                        <div class="gb-hint">{{ item.kindLabel }}</div>
                      </td>
                      <td>{{ item.reasonLabel }}</td>
                      <td class="gb-hint">{{ factDetail(item.payload) }}</td>
                      <td class="gb-hint">{{ item.sourceLabel }}</td>
                      <td>
                        @if (item.status === 'open') {
                          <div class="resolve-row">
                            <mat-form-field appearance="outline" style="width: 100%">
                              <mat-label>核对 / 处理说明</mat-label>
                              <input
                                matInput
                                [ngModel]="resolutionDraft()[item.id] || ''"
                                (ngModelChange)="setResolution(item.id, $event)"
                                placeholder="如：已补建测点 P5 / 支座为替换前编号，人工核销"
                              />
                            </mat-form-field>
                            <div class="gb-row-actions">
                              <button mat-flat-button color="primary" (click)="resolve(item.id)">
                                <mat-icon>check</mat-icon>
                                标记已处理
                              </button>
                              <button mat-button color="warn" (click)="removeReview(item.id)">
                                <mat-icon>delete</mat-icon>
                              </button>
                            </div>
                          </div>
                        } @else {
                          <div class="gb-hint">{{ item.resolution || '已处理' }} · {{ item.resolvedAt.slice(0, 10) }}</div>
                          <button mat-button (click)="reopen(item.id)">重新打开</button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      </mat-tab>

      <!-- 检查点 -->
      <mat-tab [label]="'导入检查点（' + checkpointViews().length + '）'">
        <div class="gb-tab-body">
          @if (checkpointViews().length === 0) {
            <app-empty-panel
              title="还没有导入检查点"
              description="导入现场包后自动留痕；失败会保留原始包与错误信息，可随时重试。"
              icon="save"
            />
          } @else {
            <div class="gb-table-wrap">
              <table class="gb-table">
                <thead>
                  <tr>
                    <th>桥梁</th>
                    <th>状态</th>
                    <th>事实</th>
                    <th>尝试</th>
                    <th>最近动作 / 错误</th>
                    <th style="width: 200px">操作</th>
                  </tr>
                </thead>
                <tbody>
                  @for (cp of checkpointViews(); track cp.id) {
                    <tr [class.is-open]="cp.status === 'pending'">
                      <td>{{ cp.bridgeName }}</td>
                      <td>
                        <mat-chip [class]="'cp-' + cp.status">{{ statusLabel(cp.status) }}</mat-chip>
                      </td>
                      <td>{{ cp.factCount }} 条</td>
                      <td>{{ cp.attempts }} 次</td>
                      <td class="gb-hint">
                        {{ cp.attemptedAt.slice(0, 16).replace('T', ' ') }}
                        @if (cp.lastError) {
                          <div class="error-text">错误：{{ cp.lastError }}</div>
                        }
                      </td>
                      <td>
                        <div class="gb-row-actions">
                          <button
                            mat-flat-button
                            color="primary"
                            [disabled]="cp.status !== 'pending'"
                            (click)="retry(cp.id)"
                          >
                            <mat-icon>replay</mat-icon>
                            重试
                          </button>
                          <button
                            mat-button
                            [disabled]="cp.status === 'applied'"
                            (click)="abandon(cp.id)"
                          >
                            放弃
                          </button>
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
  styles: [
    `
      .gb-tab-body {
        padding: 16px 0;
      }
      .upload-label {
        display: inline-block;
      }
      .block-banner {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #fff3e0;
        color: #e65100;
        border: 1px solid #ffcc80;
        border-radius: 8px;
        padding: 10px 12px;
        margin: 10px 0;
      }
      tr.is-open,
      tr.is-open {
        background: #fff8f0;
      }
      .resolve-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      mat-chip.outcome-applied,
      mat-chip.applied-chip {
        background: #e8f5e9 !important;
        color: #1b5e20 !important;
      }
      mat-chip.outcome-dup {
        background: #eceff1 !important;
        color: #455a64 !important;
      }
      mat-chip.outcome-review {
        background: #fff3e0 !important;
        color: #e65100 !important;
      }
      mat-chip.cp-applied {
        background: #e8f5e9 !important;
        color: #1b5e20 !important;
      }
      mat-chip.cp-pending {
        background: #ffebee !important;
        color: #b71c1c !important;
      }
      mat-chip.cp-abandoned {
        background: #eceff1 !important;
        color: #546e7a !important;
      }
      .error-text {
        color: #b71c1c;
      }
    `,
  ],
})
export class MergeCenterPage {
  private readonly store = inject(Store);
  private readonly importer = inject(FieldImportService);
  private readonly idb = inject(IdbTableService);
  private readonly snackBar = inject(MatSnackBar);

  readonly FIELD_FACT_KIND_LABEL = FIELD_FACT_KIND_LABEL;
  readonly MERGE_OUTCOME_LABEL = MERGE_OUTCOME_LABEL;

  private readonly reviewItems = toSignal(this.store.select(selectReviewItems), { initialValue: [] });
  private readonly checkpoints = toSignal(this.store.select(selectCheckpoints), { initialValue: [] });
  private readonly blockedIds = toSignal(this.store.select(selectBlockedBridgeIds), {
    initialValue: new Set<string>(),
  });
  private readonly bridges: Signal<BridgeRow[]> = toSignal(this.store.select(selectBridges), { initialValue: [] });

  readonly reviewViews = computed(() => buildReviewViews(this.reviewItems()));
  readonly checkpointViews = computed(() => buildCheckpointViews(this.checkpoints()));
  readonly openReviews = computed(() => this.reviewViews().filter((item) => item.status === 'open'));
  readonly pendingCheckpoints = computed(() => this.checkpointViews().filter((item) => item.status === 'pending'));
  readonly appliedCheckpoints = computed(() => this.checkpointViews().filter((item) => item.status === 'applied'));
  readonly blockedBridges = computed(() =>
    this.bridges().filter((bridge) => this.blockedIds().has(bridge.id)),
  );
  readonly blockedBridgeNames = computed(() =>
    this.blockedBridges()
      .map((bridge) => bridge.name)
      .join('、') || '无',
  );

  readonly previewPackage = signal<FieldPackage | null>(null);
  readonly plan = signal<MergePlan | null>(null);
  readonly alreadyApplied = signal(false);
  readonly applying = signal(false);
  readonly resolutionDraft = signal<Record<string, string>>({});

  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const parsed = await readJsonFile<unknown>(file);
      if (!isFieldPackage(parsed)) {
        this.notify('文件不是有效的现场包（缺少现场包标识或测点台账）');
        return;
      }
      const { plan, alreadyApplied } = await this.importer.preview(parsed);
      this.previewPackage.set(parsed);
      this.plan.set(plan);
      this.alreadyApplied.set(alreadyApplied);
      this.notify(
        alreadyApplied
          ? '该现场包此前已成功导入，重导将整包幂等跳过'
          : '试合并完成，请确认挂接与待复核明细',
      );
    } catch (error) {
      this.notify(`现场包解析失败：${error instanceof Error ? error.message : '文件异常'}`);
    }
  }

  async confirmApply(): Promise<void> {
    const pkg = this.previewPackage();
    if (!pkg) return;
    if (this.applying()) return;
    this.applying.set(true);
    try {
      const { report, status } = await this.importer.apply(pkg);
      this.idb.emitChange();
      this.notify(
        status === 'applied' && report.readingsApplied + report.acceptancesApplied + report.stepStatesApplied === 0
          ? '导入完成：没有新增事实（整包 / 事实幂等跳过）'
          : `合并完成：新增状态 ${report.stepStatesApplied}、读数 ${report.readingsApplied}、验收 ${report.acceptancesApplied}；待复核 ${report.reviewCreated}`,
      );
      this.clearPreview();
    } catch (error) {
      this.idb.emitChange();
      this.notify(
        `导入失败，检查点已保留，可在「导入检查点」重试：${error instanceof Error ? error.message : '事务异常'}`,
      );
    } finally {
      this.applying.set(false);
    }
  }

  clearPreview(): void {
    this.previewPackage.set(null);
    this.plan.set(null);
    this.alreadyApplied.set(false);
  }

  setResolution(id: string, value: string): void {
    this.resolutionDraft.set({ ...this.resolutionDraft(), [id]: value });
  }

  resolve(id: string): void {
    const resolution = (this.resolutionDraft()[id] ?? '').trim() || '已人工核对，确认无需挂接';
    this.store.dispatch(offlineActions.resolveReview({ id, resolution }));
  }

  reopen(id: string): void {
    this.store.dispatch(offlineActions.reopenReview({ id }));
  }

  removeReview(id: string): void {
    if (!confirm('确认删除该待复核记录？（来源现场包事实不会被重新导入，已在事实台账中留痕）')) return;
    this.store.dispatch(offlineActions.deleteReview({ id }));
  }

  retry(id: string): void {
    this.store.dispatch(offlineActions.retryCheckpoint({ id }));
  }

  abandon(id: string): void {
    if (!confirm('放弃该检查点？原始包记录会标记为已放弃且不再提示重试。')) return;
    this.store.dispatch(offlineActions.abandonCheckpoint({ id }));
  }

  outcomeClass(outcome: string): string {
    if (outcome === 'applied') return 'applied';
    if (outcome === 'review') return 'review';
    return 'dup';
  }

  statusLabel(status: string): string {
    if (status === 'applied') return '已导入';
    if (status === 'pending') return '失败待重试';
    return '已放弃';
  }

  factDetail(payload: FieldPackage['facts'][number]): string {
    if (payload.kind === 'stepState') {
      return `发放时第 ${payload.issuedSeq} 级 → ${payload.state}，记录人 ${payload.operator}（${payload.recordedAt}）`;
    }
    if (payload.kind === 'reading') {
      return `第 ${payload.issuedSeq} 级 测点 ${payload.pointCode}：位移 ${payload.displacementMm} mm / 应力 ${payload.stressMpa} MPa（${payload.recordedAt}）`;
    }
    return `支座 ${payload.issuedBearingLabel}：${payload.stage} / ${payload.conclusion}，验收人 ${payload.acceptor}（${payload.acceptedAt}）`;
  }

  private notify(message: string): void {
    this.snackBar.open(message, '关闭', { duration: 3200 });
  }
}
