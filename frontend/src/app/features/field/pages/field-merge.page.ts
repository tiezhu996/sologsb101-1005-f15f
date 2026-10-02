import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDividerModule } from '@angular/material/divider';
import { ROUTES } from '../../../core/router/app.routes';
import { IdbTableService } from '../../../core/services/idb-table.service';
import {
  listFieldOrphans,
  listImportBatches,
  listPoints,
  setPointActive,
  type FieldImportBatchDbRow,
  type FieldOrphanDbRow,
  type PointDbRow,
} from '../../../core/utils/db';
import {
  discardImportCheckpoint,
  discardOrphan,
  resolveAcceptanceOrphan,
  resolveReadingOrphan,
  retryFailedImport,
  importFieldPackage,
  buildFieldPackage,
  FieldPackageBridgeMissingError,
  FieldPackageFormatError,
} from '../../../core/utils/field-merge';
import {
  FIELD_ORPHAN_KIND_LABEL,
  FIELD_ORPHAN_REASON_LABEL,
  FIELD_ORPHAN_STATUS_LABEL,
  fieldPackageFilename,
  type FieldAcceptanceFact,
  type FieldReadingFact,
  type FieldStepFact,
  type FieldMergeReport,
} from '../../../core/types/field-package';
import { STEP_STATE_LABEL } from '../../../core/types/step';
import {
  ACCEPTANCE_CONCLUSION_LABEL,
  ACCEPTANCE_STAGE_LABEL,
  type AcceptanceStage,
} from '../../../core/types/acceptance';
import { downloadJson, readJsonFile } from '../../../core/utils/export';
import { selectBridges, selectPiers } from '../../../core/store/bridge.selectors';
import { selectBearings } from '../../../core/store/bearing.selectors';
import { selectSteps } from '../../../core/store/step.selectors';
import { StatBadgeComponent } from '../../../shared/components/common/stat-badge.component';
import { EmptyPanelComponent } from '../../../shared/components/common/empty-panel.component';

interface OrphanView extends FieldOrphanDbRow {
  bridgeName: string;
  detail: string;
}

/**
 * /field 项目部现场包离线合并页：
 * 1) 发放现场包（锚定稳定编号）；2) 导入回填包（幂等合并 + 失败检查点重试）；
 * 3) 待复核区（找不到归属的现场事实，处理前不放行该桥归档）；
 * 4) 测点台账（主台账撤去 / 恢复测点）；5) 导入批次记录。
 */
@Component({
  selector: 'app-field-merge-page',
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatDividerModule,
    StatBadgeComponent,
    EmptyPanelComponent,
  ],
  template: `
    <div class="page-head">
      <div>
        <h2 class="page-title">现场包离线合并</h2>
        <div class="page-sub">
          项目部按桥发放现场包（含稳定编号锚点），平板断网登记执行事实；回部后导入合并，按稳定编号重新挂接，
          绝不按步骤序号硬套。待复核记录处理前不放行该桥归档。
        </div>
      </div>
      <div class="gb-inline-actions">
        <button mat-stroked-button (click)="go(ROUTES.fieldTablet)">
          <mat-icon>tablet_mac</mat-icon>
          切到平板登记
        </button>
        <button mat-stroked-button (click)="refresh()">
          <mat-icon>refresh</mat-icon>
          刷新
        </button>
      </div>
    </div>

    <div class="stat-grid">
      <app-stat-badge title="待复核记录" [value]="pendingOrphans().length" [suffix]="'条'" color="#c62828"
        [hint]="'来自 ' + pendingBridges().size + ' 座桥，未处理不放行归档'" />
      <app-stat-badge title="失败检查点" [value]="failedBatches().length" [suffix]="'个'" color="#ed6c02"
        hint="导入失败已保留整包原文，可直接重试" />
      <app-stat-badge title="成功导入批次" [value]="successBatches().length" [suffix]="'次'" color="#2e7d32"
        hint="同一包再次导入自动幂等跳过，不重复生成读数 / 验收" />
      <app-stat-badge title="在册测点" [value]="activePoints().length" [suffix]="'个'" color="#1565c0"
        [hint]="'已撤去 ' + retiredPoints().length + ' 个测点（历史读数保留）'" />
    </div>

    <!-- 1. 发放现场包 -->
    <mat-card appearance="outlined" class="gb-section">
      <div style="padding: 12px 14px">
        <div class="gb-card-title">① 发放现场作业包（项目部 → 平板）</div>
        <div class="gb-hint" style="margin-top: 4px">
          包内固化步骤 / 测点 / 支座的稳定编号与当时的步骤序号；现场导入时主台账即使已重排步骤，
          仍按稳定编号落位。
        </div>
        <div class="gb-inline-actions" style="margin-top: 10px">
          <mat-form-field appearance="outline" style="min-width: 280px">
            <mat-label>选择桥梁</mat-label>
            <mat-select [ngModel]="issueBridgeId()" (ngModelChange)="issueBridgeId.set($event)">
              @for (bridge of bridges(); track bridge.id) {
                <mat-option [value]="bridge.id">{{ bridge.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" style="min-width: 200px">
            <mat-label>平板设备标识（可选）</mat-label>
            <input matInput [ngModel]="issueDevice()" (ngModelChange)="issueDevice.set($event)" placeholder="tablet-01" />
          </mat-form-field>
          <button mat-flat-button color="primary" [disabled]="!issueBridgeId() || issuing()" (click)="issue()">
            <mat-icon>outbox</mat-icon>
            {{ issuing() ? '生成中…' : '生成并下载现场包' }}
          </button>
        </div>
      </div>
    </mat-card>

    <!-- 2. 导入回填包 -->
    <mat-card appearance="outlined" class="gb-section">
      <div style="padding: 12px 14px">
        <div class="gb-card-title">② 导入现场回填包（平板 → 主台账）</div>
        <div class="gb-hint" style="margin-top: 4px">
          单事务合并：步骤状态单调推进，读数 / 验收按稳定编号增量落库，主台账已有内容保留；
          找不到归属的执行事实自动进入待复核区。
        </div>
        <div class="gb-inline-actions" style="margin-top: 10px">
          <label class="upload-label">
            <input type="file" accept="application/json" hidden (change)="handleImport($event)" />
            <span mat-flat-button color="primary">
              <mat-icon>move_to_inbox</mat-icon>
              选择回填包导入
            </span>
          </label>
          @if (lastReport(); as report) {
            <mat-chip highlighted [color]="report.duplicated ? 'accent' : 'primary'">
              {{ report.duplicated ? '该包已导入过，本次幂等跳过，未新增数据' : mergeSummary(report) }}
            </mat-chip>
          }
        </div>
      </div>
    </mat-card>

    <!-- 3. 失败检查点 -->
    @if (failedBatches().length > 0) {
      <div class="gb-section">
        <div class="gb-card-title" style="margin-bottom: 8px">失败检查点（{{ failedBatches().length }}）</div>
        <div class="gb-table-wrap">
          <table class="gb-table">
            <thead>
              <tr>
                <th>包编号</th>
                <th>桥梁</th>
                <th>来源设备</th>
                <th>失败原因</th>
                <th>时间</th>
                <th style="width: 200px">操作</th>
              </tr>
            </thead>
            <tbody>
              @for (batch of failedBatches(); track batch.packageId) {
                <tr>
                  <td class="gb-mono">{{ shortId(batch.packageId) }}</td>
                  <td>{{ batch.bridgeName }}</td>
                  <td>{{ batch.deviceCode || '—' }}</td>
                  <td class="gb-hint" style="color: #c62828">{{ batch.error }}</td>
                  <td>{{ batch.importedAt.slice(0, 16).replace('T', ' ') }}</td>
                  <td>
                    <div class="gb-row-actions">
                      <button mat-button color="primary" (click)="retry(batch.packageId)">
                        <mat-icon>replay</mat-icon> 重试
                      </button>
                      <button mat-button (click)="discardCheckpoint(batch.packageId)">
                        <mat-icon>delete_outline</mat-icon> 放弃
                      </button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    }

    <!-- 4. 待复核区 -->
    <div class="gb-section">
      <div class="gb-card-title" style="margin-bottom: 8px">
        待复核区（{{ orphanViews().length }} 条，含历史已处理）
      </div>
      @if (orphanViews().length === 0) {
        <app-empty-panel
          title="暂无待复核记录"
          description="主台账重排步骤不影响挂接；替换支座、撤去测点或删除步骤后，现场事实才会进入这里。"
          icon="rule_folder"
        />
      } @else {
        <div class="gb-table-wrap">
          <table class="gb-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>桥梁 / 来源</th>
                <th>找不到归属的原因</th>
                <th>现场记录内容</th>
                <th>状态</th>
                <th style="width: 320px">复核处理</th>
              </tr>
            </thead>
            <tbody>
              @for (orphan of orphanViews(); track orphan.id) {
                <tr [class.is-pending]="orphan.status === 'pending'">
                  <td>{{ kindLabel[orphan.kind] }}</td>
                  <td>
                    <div>{{ orphan.bridgeName }}</div>
                    <div class="gb-hint">
                      包 {{ shortId(orphan.packageId) }} · {{ orphan.deviceCode || '未知设备' }} ·
                      {{ orphan.createdAt.slice(0, 16).replace('T', ' ') }}
                    </div>
                  </td>
                  <td class="gb-hint">{{ reasonLabel[orphan.reason] }}</td>
                  <td class="gb-mono" style="white-space: pre-line">{{ orphanDetail(orphan) }}</td>
                  <td>
                    <mat-chip [highlighted]="orphan.status === 'pending'">
                      {{ statusLabel[orphan.status] }}
                    </mat-chip>
                    @if (orphan.resolveNote) {
                      <div class="gb-hint">{{ orphan.resolveNote }}</div>
                    }
                  </td>
                  <td>
                    @if (orphan.status === 'pending') {
                      @if (orphan.kind === 'reading') {
                        <div class="gb-inline-actions" style="gap: 4px">
                          <mat-form-field appearance="outline" style="min-width: 150px">
                            <mat-label>挂到步骤</mat-label>
                            <mat-select [ngModel]="resolveStep(orphan.id)" (ngModelChange)="setResolveStep(orphan.id, $event)">
                              @for (step of stepOptions(orphan.bridgeId); track step.id) {
                                <mat-option [value]="step.id">
                                  #{{ step.seq }} {{ step.targetLiftMm }}mm（{{ step.id }}）
                                </mat-option>
                              }
                            </mat-select>
                          </mat-form-field>
                          <mat-form-field appearance="outline" style="min-width: 110px">
                            <mat-label>测点编号</mat-label>
                            <input matInput [ngModel]="resolveCode(orphan.id)"
                              (ngModelChange)="setResolveCode(orphan.id, $event)" />
                          </mat-form-field>
                          <button mat-button color="primary"
                            [disabled]="!resolveStep(orphan.id) || !resolveCode(orphan.id)"
                            (click)="resolveReading(orphan)">挂接</button>
                          <button mat-button color="warn" (click)="discard(orphan)">作废</button>
                        </div>
                      } @else if (orphan.kind === 'acceptance') {
                        <div class="gb-inline-actions" style="gap: 4px">
                          <mat-form-field appearance="outline" style="min-width: 200px">
                            <mat-label>挂到现存支座</mat-label>
                            <mat-select [ngModel]="resolveBearing(orphan.id)"
                              (ngModelChange)="setResolveBearing(orphan.id, $event)">
                              @for (bearing of bearingOptions(orphan.bridgeId); track bearing.id) {
                                <mat-option [value]="bearing.id">
                                  {{ bearing.pierCode }} · {{ bearing.serial }} · {{ bearing.spec }}
                                </mat-option>
                              }
                            </mat-select>
                          </mat-form-field>
                          <button mat-button color="primary" [disabled]="!resolveBearing(orphan.id)"
                            (click)="resolveAcceptance(orphan)">挂接</button>
                          <button mat-button color="warn" (click)="discard(orphan)">作废</button>
                        </div>
                      } @else {
                        <div class="gb-hint">步骤已删除，状态事实无实体可挂。</div>
                        <button mat-button color="warn" (click)="discard(orphan)">作废该事实</button>
                      }
                    } @else {
                      <span class="gb-hint">{{ (orphan.resolvedAt ?? '').slice(0, 16).replace('T', ' ') }}</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (pendingOrphans().length > 0) {
          <mat-card appearance="outlined" style="margin-top: 10px; border-color: #c62828">
            <div style="padding: 10px 14px; color: #c62828">
              <mat-icon style="vertical-align: -4px">block</mat-icon>
              以下桥梁存在 {{ pendingOrphans().length }} 条待复核记录，处理（挂接或作废）前不放行竣工归档：
              {{ blockedBridgeNames() }}
            </div>
          </mat-card>
        }
      }
    </div>

    <!-- 5. 测点台账 -->
    <div class="gb-section">
      <div class="gb-card-title" style="margin-bottom: 8px">测点布设计划（主台账归属，{{ points().length }} 个测点）</div>
      <div class="gb-hint" style="margin-bottom: 8px">
        撤去测点后历史读数保留；若现场包仍回报该测点读数，将进入待复核区，不会静默落库。
      </div>
      <div class="gb-table-wrap">
        <table class="gb-table">
          <thead>
            <tr>
              <th>测点稳定编号</th>
              <th>所属步骤</th>
              <th>测点号</th>
              <th>状态</th>
              <th>来源</th>
              <th style="width: 140px">操作</th>
            </tr>
          </thead>
          <tbody>
            @for (point of points(); track point.id) {
              <tr [class.is-retired]="point.active === 0">
                <td class="gb-mono">{{ point.id }}</td>
                <td>{{ stepLabel(point.stepId) }}</td>
                <td class="gb-mono">{{ point.pointCode }}</td>
                <td>
                  @if (point.active === 1) {
                    <mat-chip highlighted class="stage-done">启用</mat-chip>
                  } @else {
                    <mat-chip class="stage-pending">已撤去</mat-chip>
                  }
                </td>
                <td class="gb-hint">{{ point.createdByPackageId ? '现场补登 ' + shortId(point.createdByPackageId) : '主台账' }}</td>
                <td>
                  @if (point.active === 1) {
                    <button mat-button color="warn" (click)="togglePoint(point, false)">撤去测点</button>
                  } @else {
                    <button mat-button color="primary" (click)="togglePoint(point, true)">恢复测点</button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    <!-- 6. 导入批次记录 -->
    <div class="gb-section">
      <div class="gb-card-title" style="margin-bottom: 8px">导入批次记录（最近 {{ batches().length }} 条）</div>
      <div class="gb-table-wrap">
        <table class="gb-table">
          <thead>
            <tr>
              <th>包编号</th>
              <th>桥梁</th>
              <th>状态</th>
              <th>来源设备</th>
              <th>时间</th>
              <th>合并结果</th>
            </tr>
          </thead>
          <tbody>
            @for (batch of batches(); track batch.packageId) {
              <tr>
                <td class="gb-mono">{{ shortId(batch.packageId) }}</td>
                <td>{{ batch.bridgeName }}</td>
                <td>
                  @if (batch.status === 'succeeded') {
                    <mat-chip highlighted class="stage-done">成功</mat-chip>
                  } @else {
                    <mat-chip class="stage-pending">失败检查点</mat-chip>
                  }
                </td>
                <td>{{ batch.deviceCode || '—' }}</td>
                <td>{{ batch.importedAt.slice(0, 16).replace('T', ' ') }}</td>
                <td class="gb-hint">
                  @if (batch.lastReport) {
                    {{ batchSummary(batch) }}
                  } @else {
                    {{ batch.error }}
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
  `,
  styles: [
    `
      .upload-label {
        display: inline-block;
      }
      .upload-label span[mat-flat-button] {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 36px;
        padding: 0 16px;
        border-radius: 6px;
        background: #1565c0;
        color: #fff;
        cursor: pointer;
        font-size: 14px;
      }
      mat-chip.stage-done {
        background: #e8f5e9 !important;
        color: #1b5e20 !important;
      }
      mat-chip.stage-pending {
        background: #eceff1 !important;
        color: #546e7a !important;
      }
      tr.is-pending {
        background: #fff8f8;
      }
      tr.is-retired {
        opacity: 0.65;
      }
    `,
  ],
})
export class FieldMergePage {
  private readonly store = inject(Store);
  private readonly idb = inject(IdbTableService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);

  readonly ROUTES = ROUTES;
  readonly kindLabel = FIELD_ORPHAN_KIND_LABEL;
  readonly reasonLabel = FIELD_ORPHAN_REASON_LABEL;
  readonly statusLabel = FIELD_ORPHAN_STATUS_LABEL;

  readonly bridges = toSignal(this.store.select(selectBridges), { initialValue: [] });
  private readonly piers = toSignal(this.store.select(selectPiers), { initialValue: [] });
  private readonly bearings = toSignal(this.store.select(selectBearings), { initialValue: [] });
  private readonly steps = toSignal(this.store.select(selectSteps), { initialValue: [] });

  readonly issueBridgeId = signal('');
  readonly issueDevice = signal('tablet-01');
  readonly issuing = signal(false);
  readonly lastReport = signal<FieldMergeReport | null>(null);

  readonly points = signal<PointDbRow[]>([]);
  readonly orphans = signal<FieldOrphanDbRow[]>([]);
  readonly batches = signal<FieldImportBatchDbRow[]>([]);
  private readonly resolveSteps = signal<Record<string, string>>({});
  private readonly resolveCodes = signal<Record<string, string>>({});
  private readonly resolveBearings = signal<Record<string, string>>({});

  readonly activePoints = computed(() => this.points().filter((point) => point.active === 1));
  readonly retiredPoints = computed(() => this.points().filter((point) => point.active === 0));
  readonly failedBatches = computed(() => this.batches().filter((batch) => batch.status === 'failed'));
  readonly successBatches = computed(() => this.batches().filter((batch) => batch.status === 'succeeded'));

  readonly orphanViews = computed<OrphanView[]>(() => {
    const bridgeName = new Map(this.bridges().map((bridge) => [bridge.id, bridge.name]));
    return this.orphans().map((orphan) => ({
      ...orphan,
      bridgeName: bridgeName.get(orphan.bridgeId) ?? `已删桥梁 ${orphan.bridgeId}`,
      detail: '',
    }));
  });

  readonly pendingOrphans = computed(() => this.orphanViews().filter((orphan) => orphan.status === 'pending'));
  readonly pendingBridges = computed(() => new Set(this.pendingOrphans().map((orphan) => orphan.bridgeId)));
  readonly blockedBridgeNames = computed(() => {
    const names = this.bridges()
      .filter((bridge) => this.pendingBridges().has(bridge.id))
      .map((bridge) => bridge.name);
    return names.length ? names.join('、') : '—';
  });

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const [points, orphans, batches] = await Promise.all([listPoints(), listFieldOrphans(), listImportBatches()]);
    this.points.set(points);
    this.orphans.set(orphans);
    this.batches.set(batches);
  }

  shortId(id: string): string {
    return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
  }

  stepLabel(stepId: string): string {
    const step = this.steps().find((item) => item.id === stepId);
    if (!step) return `已删步骤 ${stepId}`;
    return `#${step.seq} 目标 ${step.targetLiftMm}mm（${stepId}）`;
  }

  stepOptions(bridgeId: string) {
    return this.steps()
      .filter((step) => step.bridgeId === bridgeId)
      .sort((a, b) => a.seq - b.seq);
  }

  bearingOptions(bridgeId: string) {
    const pierIds = new Set(this.piers().filter((pier) => pier.bridgeId === bridgeId).map((pier) => pier.id));
    const pierCode = new Map(this.piers().map((pier) => [pier.id, pier.code]));
    return this.bearings()
      .filter((bearing) => pierIds.has(bearing.pierId))
      .map((bearing) => ({
        id: bearing.id,
        pierCode: pierCode.get(bearing.pierId) ?? '—',
        serial: bearing.serial,
        spec: bearing.spec,
      }));
  }

  resolveStep(id: string): string {
    return this.resolveSteps()[id] ?? '';
  }

  setResolveStep(id: string, value: string): void {
    this.resolveSteps.set({ ...this.resolveSteps(), [id]: value });
  }

  resolveCode(id: string): string {
    return this.resolveCodes()[id] ?? '';
  }

  setResolveCode(id: string, value: string): void {
    this.resolveCodes.set({ ...this.resolveCodes(), [id]: value });
  }

  resolveBearing(id: string): string {
    return this.resolveBearings()[id] ?? '';
  }

  setResolveBearing(id: string, value: string): void {
    this.resolveBearings.set({ ...this.resolveBearings(), [id]: value });
  }

  orphanDetail(orphan: FieldOrphanDbRow): string {
    const fact = orphan.payload as FieldStepFact | FieldReadingFact | FieldAcceptanceFact;
    if (orphan.kind === 'step') {
      const stepFact = fact as FieldStepFact;
      return `步骤 ${stepFact.stepId}\n回报状态：${STEP_STATE_LABEL[stepFact.state]}\n时间：${stepFact.recordedAt} · ${stepFact.operator}`;
    }
    if (orphan.kind === 'reading') {
      const reading = fact as FieldReadingFact;
      return `步骤 ${reading.stepId} / 测点 ${reading.pointCode}\n位移 ${reading.displacementMm}mm · 应力 ${reading.stressMpa}MPa\n时间：${reading.recordedAt} · ${reading.operator}`;
    }
    const acceptance = fact as FieldAcceptanceFact;
    return `支座 ${acceptance.bearingId}\n${ACCEPTANCE_STAGE_LABEL[acceptance.stage]}：${ACCEPTANCE_CONCLUSION_LABEL[acceptance.conclusion]}\n时间：${acceptance.acceptedAt} · ${acceptance.acceptor}`;
  }

  mergeSummary(report: FieldMergeReport): string {
    return `步骤推进 ${report.stepsApplied} · 新读数 ${report.readingsInserted}（跳过重复 ${report.readingsSkipped}）· 新验收 ${report.acceptancesInserted}（跳过 ${report.acceptancesSkipped}）· 待复核 ${report.orphansCreated}`;
  }

  batchSummary(batch: FieldImportBatchDbRow): string {
    if (!batch.lastReport) return batch.error ?? '';
    try {
      return this.mergeSummary(JSON.parse(batch.lastReport) as FieldMergeReport);
    } catch {
      return '';
    }
  }

  async issue(): Promise<void> {
    const bridgeId = this.issueBridgeId();
    if (!bridgeId) return;
    this.issuing.set(true);
    try {
      const pkg = await buildFieldPackage({ bridgeId, deviceCode: this.issueDevice().trim() || undefined });
      downloadJson(fieldPackageFilename(pkg), pkg);
      this.notify(`已发放现场包 ${this.shortId(pkg.packageId)}，含 ${pkg.anchors.steps.length} 个步骤、${pkg.anchors.points.length} 个测点、${pkg.anchors.bearings.length} 个支座锚点`);
    } catch (error) {
      this.notify(error instanceof Error ? error.message : '生成现场包失败');
    } finally {
      this.issuing.set(false);
    }
  }

  async handleImport(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = await readJsonFile(file);
    } catch {
      this.notify('文件不是合法 JSON');
      return;
    }
    try {
      const report = await importFieldPackage(parsed, { fileName: file.name });
      await this.afterWrite();
      this.lastReport.set(report);
      if (report.duplicated) {
        this.notify('该现场包此前已成功导入，本次幂等跳过，未新增任何读数 / 验收');
      } else {
        this.notify(`合并完成：${this.mergeSummary(report)}`);
      }
    } catch (error) {
      await this.refresh();
      if (error instanceof FieldPackageFormatError) {
        this.notify(`现场包格式不正确：${error.message}`);
      } else if (error instanceof FieldPackageBridgeMissingError) {
        this.notify(`${error.message}；已保留检查点，可在下方重试`);
      } else {
        this.notify(`导入失败（已回滚并保留检查点）：${error instanceof Error ? error.message : '未知错误'}`);
      }
    }
  }

  async retry(packageId: string): Promise<void> {
    try {
      const report = await retryFailedImport(packageId);
      await this.afterWrite();
      this.lastReport.set(report);
      this.notify(`重试成功：${this.mergeSummary(report)}`);
    } catch (error) {
      await this.refresh();
      this.notify(`重试仍失败，检查点继续保留：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  async discardCheckpoint(packageId: string): Promise<void> {
    if (!confirm('放弃该失败检查点？整包原文将被删除（主台账未受影响）。')) return;
    await discardImportCheckpoint(packageId);
    await this.refresh();
    this.notify('检查点已删除');
  }

  async resolveReading(orphan: OrphanView): Promise<void> {
    const stepId = this.resolveStep(orphan.id);
    const code = this.resolveCode(orphan.id)?.trim();
    if (!stepId || !code) return;
    try {
      await resolveReadingOrphan({ orphanId: orphan.id, targetStepId: stepId, targetPointCode: code });
      await this.afterWrite();
      this.notify('读数已重新挂接');
    } catch (error) {
      this.notify(error instanceof Error ? error.message : '挂接失败');
    }
  }

  async resolveAcceptance(orphan: OrphanView): Promise<void> {
    const bearingId = this.resolveBearing(orphan.id);
    if (!bearingId) return;
    try {
      await resolveAcceptanceOrphan({ orphanId: orphan.id, targetBearingId: bearingId });
      await this.afterWrite();
      this.notify('验收已重新挂接到现存支座');
    } catch (error) {
      this.notify(error instanceof Error ? error.message : '挂接失败');
    }
  }

  async discard(orphan: OrphanView): Promise<void> {
    if (!confirm('确认作废该条现场记录？作废后不再阻塞归档，但来源记录仍保留在批次历史中。')) return;
    await discardOrphan(orphan.id);
    await this.afterWrite();
    this.notify('现场记录已作废');
  }

  async togglePoint(point: PointDbRow, active: boolean): Promise<void> {
    await setPointActive(point.id, active);
    this.idb.emitChange();
    await this.refresh();
    this.notify(active ? `测点 ${point.pointCode} 已恢复` : `测点 ${point.pointCode} 已撤去（历史读数保留）`);
  }

  private async afterWrite(): Promise<void> {
    this.idb.emitChange();
    await this.refresh();
  }

  go(path: string): void {
    void this.router.navigate([path]);
  }

  private notify(message: string): void {
    this.snackBar.open(message, '关闭', { duration: 3200 });
  }
}
