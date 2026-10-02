import { Component, computed, effect, inject, signal, type Signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
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
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { selectBridges, selectPiers } from '../../../core/store/bridge.selectors';
import { selectBearings } from '../../../core/store/bearing.selectors';
import { selectSteps } from '../../../core/store/step.selectors';
import { selectPoints } from '../../../core/store/offline.selectors';
import type { BridgeRow, PierRow, BearingRow, StepRow, PointRow, FieldPackageRecord } from '../../../core/utils/db';
import { STEP_STATES, STEP_STATE_LABEL, type StepState } from '../../../core/types/step';
import {
  ACCEPTANCE_CONCLUSIONS,
  ACCEPTANCE_CONCLUSION_LABEL,
  ACCEPTANCE_STAGES,
  ACCEPTANCE_STAGE_LABEL,
  type AcceptanceConclusion,
  type AcceptanceStage,
} from '../../../core/types/acceptance';
import {
  countFacts,
  fieldPackageFilename,
  type FieldPackage,
} from '../../../core/types/field-package';
import { issueFieldPackage } from '../../../core/utils/field-package';
import { downloadJson, nowDateTime } from '../../../core/utils/export';
import { FieldDeskService } from '../../../core/services/field-desk.service';
import { IdbTableService } from '../../../core/services/idb-table.service';
import { StatBadgeComponent } from '../../../shared/components/common/stat-badge.component';
import { EmptyPanelComponent } from '../../../shared/components/common/empty-panel.component';

/**
 * /field 现场离线作业（平板）
 * 按主台账当前归属发放现场包（冻结稳定编号快照），断网登记步骤状态 / 测点读数 /
 * 分步验收三类执行事实；回项目部前封包导出 JSON。现场只写 facts，不改主台账。
 */
@Component({
  selector: 'app-field-desk-page',
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
    MatTabsModule,
    MatTooltipModule,
    StatBadgeComponent,
    EmptyPanelComponent,
  ],
  template: `
    <div class="page-head">
      <div>
        <h2 class="page-title">现场离线作业（平板）</h2>
        <div class="page-sub">
          按发放包内的稳定编号登记步骤状态、测点读数与分步验收；断网数据先存本机，封包后回项目部合并。
        </div>
      </div>
      <div class="gb-inline-actions">
        <button mat-stroked-button (click)="refreshDrafts()">
          <mat-icon>refresh</mat-icon>
          刷新本机草稿
        </button>
      </div>
    </div>

    <div class="stat-grid">
      <app-stat-badge title="本机作业包" [value]="drafts().length" suffix="个" color="#1565c0" />
      <app-stat-badge
        title="未封包"
        [value]="openDraftCount()"
        suffix="个"
        color="#ef6c00"
        hint="未封包仍可继续登记事实"
      />
      <app-stat-badge
        title="已登记事实"
        [value]="totalFacts()"
        suffix="条"
        color="#00897b"
        [hint]="'状态 ' + factTotals().stepStates + ' / 读数 ' + factTotals().readings + ' / 验收 ' + factTotals().acceptances"
      />
      <app-stat-badge title="已封包" [value]="sealedCount()" suffix="个" color="#3949ab" hint="封包后只能导出，不能再登记" />
    </div>

    <mat-tab-group mat-stretch-tabs="false" class="gb-section">
      <!-- 发放新包 -->
      <mat-tab label="发放现场包">
        <div class="gb-tab-body">
          <mat-card appearance="outlined">
            <div style="padding: 14px 16px">
              <div class="gb-card-title">选择桥梁并冻结主台账快照</div>
              <div class="gb-hint" style="margin: 6px 0 12px">
                包内固定步骤 / 支座 / 测点的稳定编号；即使回项目部后步骤被重排、支座被替换或测点被撤去，
                导入仍按稳定编号挂接。
              </div>
              <div class="gb-form-grid">
                <mat-form-field appearance="outline">
                  <mat-label>桥梁</mat-label>
                  <mat-select [ngModel]="issueBridgeId()" (ngModelChange)="issueBridgeId.set($event)">
                    @for (bridge of bridges(); track bridge.id) {
                      <mat-option [value]="bridge.id">{{ bridge.name }}</mat-option>
                    }
                  </mat-select>
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>发放人</mat-label>
                  <input matInput [ngModel]="issuedBy()" (ngModelChange)="issuedBy.set($event)" />
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>设备 / 班组标识</mat-label>
                  <input matInput [ngModel]="deviceTag()" (ngModelChange)="deviceTag.set($event)" placeholder="如 3号平板-顶升一班" />
                </mat-form-field>
              </div>
              <div class="gb-tags" style="margin-bottom: 12px">
                <mat-chip highlighted>步骤 {{ issueScope().steps }} 级</mat-chip>
                <mat-chip highlighted>支座 {{ issueScope().bearings }} 个</mat-chip>
                <mat-chip highlighted>测点 {{ issueScope().points }} 个</mat-chip>
                <mat-chip>墩台 {{ issueScope().piers }} 个</mat-chip>
              </div>
              <button mat-flat-button color="primary" [disabled]="!issueBridgeId()" (click)="issue()">
                <mat-icon>ios_share</mat-icon>
                发放并开始登记
              </button>
            </div>
          </mat-card>
        </div>
      </mat-tab>

      <!-- 作业中 -->
      <mat-tab [label]="'作业登记' + (activeDraft() ? '' : '')">
        <div class="gb-tab-body">
          @if (!activeDraft(); as none) {
            <app-empty-panel
              title="尚未打开作业包"
              description="在「发放现场包」页签选择桥梁发放，或从下方本机作业包列表打开一个已有草稿。"
              icon="work"
            />
          } @else {
            @if (activeDraft(); as pkg) {
              <!-- 包概要与封包 -->
              <mat-card appearance="outlined" class="gb-section">
                <div style="padding: 14px 16px">
                  <div class="gb-card-title">
                    {{ pkg.bridge.name }} · 作业包
                    @if (pkg.sealedAt) {
                      <mat-chip class="sealed-chip">已封包 {{ pkg.sealedAt.slice(0, 10) }}</mat-chip>
                    } @else {
                      <mat-chip class="draft-chip">登记中</mat-chip>
                    }
                  </div>
                  <div class="gb-hint" style="margin-top: 4px">
                    发放于 {{ pkg.issuedAt.slice(0, 16).replace('T', ' ') }} · 发放人 {{ pkg.issuedBy || '-' }} ·
                    {{ pkg.deviceTag || '未标注设备' }} · 包号 {{ pkg.packageId.slice(0, 18) }}…
                  </div>
                  <div class="gb-inline-actions" style="margin-top: 10px">
                    <button mat-flat-button color="primary" [disabled]="pkg.sealedAt || pkg.facts.length === 0" (click)="seal(pkg)">
                      <mat-icon>fact_check</mat-icon>
                      封包回项目部
                    </button>
                    <button mat-stroked-button [disabled]="!pkg.sealedAt" (click)="exportPkg(pkg)">
                      <mat-icon>download</mat-icon>
                      导出回传 JSON
                    </button>
                  </div>
                </div>
              </mat-card>

              <!-- 三类事实登记 -->
              <div class="field-grid">
                <!-- 步骤状态 -->
                <mat-card appearance="outlined">
                  <div style="padding: 12px 14px">
                    <div class="gb-card-title">① 步骤状态</div>
                    <div class="gb-hint">按稳定编号选择步骤（括号内为发放时序号，仅供核对）。</div>
                    <div class="gb-form-grid" style="margin-top: 8px">
                      <mat-form-field appearance="outline">
                        <mat-label>步骤</mat-label>
                        <mat-select
                          [ngModel]="formStepId()"
                          (ngModelChange)="formStepId.set($event)"
                          [disabled]="!!pkg.sealedAt"
                        >
                          @for (step of pkg.context.steps; track step.id) {
                            <mat-option [value]="step.id">#{{ step.seq }} · {{ step.targetLiftMm }}mm · {{ step.leader }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>状态</mat-label>
                        <mat-select
                          [ngModel]="formStepState()"
                          (ngModelChange)="formStepState.set($event)"
                          [disabled]="!!pkg.sealedAt"
                        >
                          @for (state of stepStates; track state) {
                            <mat-option [value]="state">{{ stepStateLabel[state] }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>记录人</mat-label>
                        <input matInput [ngModel]="operator()" (ngModelChange)="operator.set($event)" [disabled]="!!pkg.sealedAt" />
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>记录时间</mat-label>
                        <input
                          matInput
                          type="datetime-local"
                          [ngModel]="recordedAt()"
                          (ngModelChange)="recordedAt.set($event)"
                          [disabled]="!!pkg.sealedAt"
                        />
                      </mat-form-field>
                    </div>
                    <button
                      mat-flat-button
                      color="primary"
                      [disabled]="!!pkg.sealedAt || !formStepId()"
                      (click)="addStepState(pkg)"
                    >
                      登记步骤状态
                    </button>
                  </div>
                </mat-card>

                <!-- 测点读数 -->
                <mat-card appearance="outlined">
                  <div style="padding: 12px 14px">
                    <div class="gb-card-title">② 测点读数</div>
                    <div class="gb-hint">测点为发放包内的稳定测点；撤去测点的读数导入后会进待复核区。</div>
                    <div class="gb-form-grid" style="margin-top: 8px">
                      <mat-form-field appearance="outline">
                        <mat-label>步骤</mat-label>
                        <mat-select
                          [ngModel]="formReadStepId()"
                          (ngModelChange)="onReadStepChange($event)"
                          [disabled]="!!pkg.sealedAt"
                        >
                          @for (step of pkg.context.steps; track step.id) {
                            <mat-option [value]="step.id">#{{ step.seq }} · {{ step.targetLiftMm }}mm</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>测点</mat-label>
                        <mat-select
                          [ngModel]="formPointId()"
                          (ngModelChange)="formPointId.set($event)"
                          [disabled]="!!pkg.sealedAt"
                        >
                          @for (point of pointsForReadStep(); track point.id) {
                            <mat-option [value]="point.id">{{ point.pointCode }} · {{ point.location }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>位移 mm</mat-label>
                        <input
                          matInput
                          type="number"
                          step="0.01"
                          [ngModel]="displacement()"
                          (ngModelChange)="setDisplacement($event)"
                          [disabled]="!!pkg.sealedAt"
                        />
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>应力 MPa</mat-label>
                        <input
                          matInput
                          type="number"
                          step="0.01"
                          [ngModel]="stress()"
                          (ngModelChange)="setStress($event)"
                          [disabled]="!!pkg.sealedAt"
                        />
                      </mat-form-field>
                    </div>
                    <button
                      mat-flat-button
                      color="primary"
                      [disabled]="!!pkg.sealedAt || !formPointId()"
                      (click)="addReading(pkg)"
                    >
                      登记读数
                    </button>
                  </div>
                </mat-card>

                <!-- 分步验收 -->
                <mat-card appearance="outlined">
                  <div style="padding: 12px 14px">
                    <div class="gb-card-title">③ 分步验收</div>
                    <div class="gb-hint">按支座稳定编号签署；替换掉的旧支座验收会进待复核区。</div>
                    <div class="gb-form-grid" style="margin-top: 8px">
                      <mat-form-field appearance="outline">
                        <mat-label>支座</mat-label>
                        <mat-select
                          [ngModel]="formBearingId()"
                          (ngModelChange)="formBearingId.set($event)"
                          [disabled]="!!pkg.sealedAt"
                        >
                          @for (bearing of pkg.context.bearings; track bearing.id) {
                            <mat-option [value]="bearing.id">
                              {{ bearing.pierCode }} · {{ bearing.serial }} · {{ bearing.spec }}
                            </mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>分步</mat-label>
                        <mat-select
                          [ngModel]="formStage()"
                          (ngModelChange)="formStage.set($event)"
                          [disabled]="!!pkg.sealedAt"
                        >
                          @for (stage of stages; track stage) {
                            <mat-option [value]="stage">{{ stageLabel[stage] }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>结论</mat-label>
                        <mat-select
                          [ngModel]="formConclusion()"
                          (ngModelChange)="formConclusion.set($event)"
                          [disabled]="!!pkg.sealedAt"
                        >
                          @for (conclusion of conclusions; track conclusion) {
                            <mat-option [value]="conclusion">{{ conclusionLabel[conclusion] }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                      <mat-form-field appearance="outline">
                        <mat-label>验收人</mat-label>
                        <input matInput [ngModel]="acceptor()" (ngModelChange)="acceptor.set($event)" [disabled]="!!pkg.sealedAt" />
                      </mat-form-field>
                    </div>
                    <button
                      mat-flat-button
                      color="primary"
                      [disabled]="!!pkg.sealedAt || !formBearingId()"
                      (click)="addAcceptance(pkg)"
                    >
                      登记验收
                    </button>
                  </div>
                </mat-card>
              </div>

              <!-- 已登记事实清单 -->
              <mat-card appearance="outlined" class="gb-section">
                <div style="padding: 12px 14px">
                  <div class="gb-card-title">
                    已登记执行事实（{{ pkg.facts.length }} 条）
                  </div>
                  @if (pkg.facts.length === 0) {
                    <div class="gb-hint" style="padding: 10px 0">还没有登记任何事实。</div>
                  } @else {
                    <div class="gb-table-wrap">
                      <table class="gb-table">
                        <thead>
                          <tr>
                            <th>类别</th>
                            <th>内容</th>
                            <th>稳定编号</th>
                            <th style="width: 90px">操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          @for (fact of pkg.facts; track fact.factId) {
                            <tr>
                              <td>{{ kindLabel(fact.kind) }}</td>
                              <td>{{ factText(fact) }}</td>
                              <td class="gb-mono gb-hint">{{ factId(fact) }}</td>
                              <td>
                                <button mat-button color="warn" [disabled]="!!pkg.sealedAt" (click)="deleteFact(pkg, fact.factId)">
                                  <mat-icon>delete</mat-icon>
                                </button>
                              </td>
                            </tr>
                          }
                        </tbody>
                      </table>
                    </div>
                  }
                </div>
              </mat-card>
            }
          }
        </div>
      </mat-tab>

      <!-- 本机作业包 -->
      <mat-tab [label]="'本机作业包（' + drafts().length + '）'">
        <div class="gb-tab-body">
          @if (drafts().length === 0) {
            <app-empty-panel
              title="本机还没有作业包"
              description="在「发放现场包」页签发放后，草稿会保存在本机，断网也可登记。"
              icon="inventory_2"
            />
          } @else {
            <div class="gb-table-wrap">
              <table class="gb-table">
                <thead>
                  <tr>
                    <th>桥梁</th>
                    <th>状态</th>
                    <th>事实</th>
                    <th>设备 / 班组</th>
                    <th>更新时间</th>
                    <th style="width: 280px">操作</th>
                  </tr>
                </thead>
                <tbody>
                  @for (record of drafts(); track record.packageId) {
                    <tr [class.is-active]="activeDraft()?.packageId === record.packageId">
                      <td>{{ record.pkg.bridge.name }}</td>
                      <td>
                        @if (record.pkg.sealedAt) {
                          <mat-chip class="sealed-chip">已封包</mat-chip>
                        } @else {
                          <mat-chip class="draft-chip">登记中</mat-chip>
                        }
                      </td>
                      <td>
                        {{ countFacts(record.pkg.facts).stepStates }} 状态 /
                        {{ countFacts(record.pkg.facts).readings }} 读数 /
                        {{ countFacts(record.pkg.facts).acceptances }} 验收
                      </td>
                      <td>{{ record.pkg.deviceTag || '-' }}</td>
                      <td class="gb-hint">{{ record.updatedAt.slice(0, 16).replace('T', ' ') }}</td>
                      <td>
                        <div class="gb-row-actions">
                          <button mat-button color="primary" (click)="openDraft(record.pkg)">打开</button>
                          <button mat-stroked-button [disabled]="!record.pkg.sealedAt" (click)="exportPkg(record.pkg)">
                            <mat-icon>download</mat-icon>
                            导出
                          </button>
                          <button mat-button color="warn" (click)="removeDraft(record.packageId)">删除</button>
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
      .field-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 12px;
      }
      mat-chip.draft-chip {
        background: #fff3e0 !important;
        color: #e65100 !important;
      }
      mat-chip.sealed-chip {
        background: #e8f5e9 !important;
        color: #1b5e20 !important;
      }
      tr.is-active {
        background: #e3f2fd;
      }
    `,
  ],
})
export class FieldDeskPage {
  private readonly store = inject(Store);
  private readonly desk = inject(FieldDeskService);
  private readonly idb = inject(IdbTableService);
  private readonly snackBar = inject(MatSnackBar);

  readonly stepStates = STEP_STATES;
  readonly stepStateLabel = STEP_STATE_LABEL;
  readonly stages = ACCEPTANCE_STAGES;
  readonly stageLabel = ACCEPTANCE_STAGE_LABEL;
  readonly conclusions = ACCEPTANCE_CONCLUSIONS;
  readonly conclusionLabel = ACCEPTANCE_CONCLUSION_LABEL;
  readonly countFacts = countFacts;

  readonly bridges: Signal<BridgeRow[]> = toSignal(this.store.select(selectBridges), { initialValue: [] });
  private readonly piers: Signal<PierRow[]> = toSignal(this.store.select(selectPiers), { initialValue: [] });
  private readonly bearings: Signal<BearingRow[]> = toSignal(this.store.select(selectBearings), { initialValue: [] });
  private readonly steps: Signal<StepRow[]> = toSignal(this.store.select(selectSteps), { initialValue: [] });
  private readonly points: Signal<PointRow[]> = toSignal(this.store.select(selectPoints), { initialValue: [] });

  readonly drafts = signal<FieldPackageRecord[]>([]);
  readonly activeDraft = signal<FieldPackage | null>(null);

  readonly issueBridgeId = signal('');
  readonly issuedBy = signal('现场技术员');
  readonly deviceTag = signal('顶升一班平板');

  readonly formStepId = signal('');
  readonly formStepState = signal<StepState>('lifting');
  readonly formReadStepId = signal('');
  readonly formPointId = signal('');
  readonly formBearingId = signal('');
  readonly formStage = signal<AcceptanceStage>('lifted');
  readonly formConclusion = signal<AcceptanceConclusion>('pass');
  readonly operator = signal('陈立强');
  readonly acceptor = signal('王监理');
  readonly recordedAt = signal(nowDateTime().replace(' ', 'T'));
  readonly displacement = signal(0);
  readonly stress = signal(0);

  readonly issueScope = computed(() => {
    const bridgeId = this.issueBridgeId();
    const pierIds = new Set(this.piers().filter((pier) => pier.bridgeId === bridgeId).map((pier) => pier.id));
    const bridgeSteps = this.steps().filter((step) => step.bridgeId === bridgeId);
    const stepIds = new Set(bridgeSteps.map((step) => step.id));
    return {
      piers: this.piers().filter((pier) => pier.bridgeId === bridgeId).length,
      bearings: this.bearings().filter((bearing) => pierIds.has(bearing.pierId)).length,
      steps: bridgeSteps.length,
      points: this.points().filter((point) => stepIds.has(point.stepId)).length,
    };
  });

  readonly openDraftCount = computed(() => this.drafts().filter((record) => !record.pkg.sealedAt).length);
  readonly sealedCount = computed(() => this.drafts().filter((record) => record.pkg.sealedAt).length);
  readonly totalFacts = computed(() =>
    this.drafts().reduce((sum, record) => sum + record.pkg.facts.length, 0),
  );
  readonly factTotals = computed(() => {
    const totals = { stepStates: 0, readings: 0, acceptances: 0 };
    for (const record of this.drafts()) {
      const count = countFacts(record.pkg.facts);
      totals.stepStates += count.stepStates;
      totals.readings += count.readings;
      totals.acceptances += count.acceptances;
    }
    return totals;
  });

  readonly pointsForReadStep = computed(() => {
    const pkg = this.activeDraft();
    const stepId = this.formReadStepId();
    if (!pkg) return [];
    return pkg.context.points.filter((point) => point.stepId === stepId);
  });

  constructor() {
    void this.refreshDrafts();
    // 桥梁列表异步加载完成后，默认选中第一座
    effect(() => {
      if (!this.issueBridgeId() && this.bridges().length > 0) {
        this.issueBridgeId.set(this.bridges()[0].id);
      }
    });
  }

  async refreshDrafts(): Promise<void> {
    this.drafts.set(await this.desk.listDrafts());
  }

  async issue(): Promise<void> {
    const bridge = this.bridges().find((item) => item.id === this.issueBridgeId());
    if (!bridge) return;
    const piers = this.piers().filter((pier) => pier.bridgeId === bridge.id);
    const pierIds = new Set(piers.map((pier) => pier.id));
    const pkg = issueFieldPackage({
      bridge,
      piers,
      bearings: this.bearings().filter((bearing) => pierIds.has(bearing.pierId)),
      steps: this.steps().filter((step) => step.bridgeId === bridge.id),
      points: this.points().filter((point) =>
        this.steps().some((step) => step.bridgeId === bridge.id && step.id === point.stepId),
      ),
      issuedBy: this.issuedBy(),
      deviceTag: this.deviceTag(),
    });
    await this.desk.saveDraft(pkg);
    await this.refreshDrafts();
    this.activeDraft.set(pkg);
    this.formStepId.set(pkg.context.steps[0]?.id ?? '');
    this.onReadStepChange(pkg.context.steps[0]?.id ?? '');
    this.formBearingId.set(pkg.context.bearings[0]?.id ?? '');
    this.notify(`已为「${bridge.name}」发放现场包，可离线登记`);
  }

  openDraft(pkg: FieldPackage): void {
    this.activeDraft.set(pkg);
    this.formStepId.set(pkg.context.steps[0]?.id ?? '');
    this.onReadStepChange(pkg.context.steps[0]?.id ?? '');
    this.formBearingId.set(pkg.context.bearings[0]?.id ?? '');
  }

  onReadStepChange(stepId: string): void {
    this.formReadStepId.set(stepId);
    const pkg = this.activeDraft();
    const first = pkg?.context.points.find((point) => point.stepId === stepId);
    this.formPointId.set(first?.id ?? '');
  }

  setDisplacement(value: string | number): void {
    this.displacement.set(Number(value));
  }

  setStress(value: string | number): void {
    this.stress.set(Number(value));
  }

  async addStepState(pkg: FieldPackage): Promise<void> {
    const next = await this.desk.recordStepState(pkg, {
      stepId: this.formStepId(),
      state: this.formStepState(),
      recordedAt: this.recordedAt().replace('T', ' '),
      operator: this.operator(),
    });
    this.activeDraft.set(next);
    await this.refreshDrafts();
    this.notify('步骤状态已登记（同步骤以最新一条为准）');
  }

  async addReading(pkg: FieldPackage): Promise<void> {
    const point = pkg.context.points.find((item) => item.id === this.formPointId());
    if (!point) return;
    const next = await this.desk.recordReading(pkg, {
      stepId: this.formReadStepId(),
      pointId: point.id,
      pointCode: point.pointCode,
      displacementMm: this.displacement(),
      stressMpa: this.stress(),
      recordedAt: this.recordedAt().replace('T', ' '),
      operator: this.operator(),
    });
    this.activeDraft.set(next);
    await this.refreshDrafts();
    this.notify('测点读数已登记');
  }

  async addAcceptance(pkg: FieldPackage): Promise<void> {
    const next = await this.desk.recordAcceptance(pkg, {
      bearingId: this.formBearingId(),
      stage: this.formStage(),
      conclusion: this.formConclusion(),
      acceptor: this.acceptor(),
      acceptedAt: this.recordedAt().replace('T', ' '),
    });
    this.activeDraft.set(next);
    await this.refreshDrafts();
    this.notify('分步验收已登记');
  }

  async deleteFact(pkg: FieldPackage, factId: string): Promise<void> {
    const next = await this.desk.deleteFact(pkg, factId);
    this.activeDraft.set(next);
    await this.refreshDrafts();
  }

  async seal(pkg: FieldPackage): Promise<void> {
    const next = await this.desk.seal(pkg);
    this.activeDraft.set(next);
    await this.refreshDrafts();
    this.notify('已封包，请导出 JSON 回项目部合并');
  }

  exportPkg(pkg: FieldPackage): void {
    if (!pkg.sealedAt) {
      this.notify('请先封包再导出回传');
      return;
    }
    downloadJson(fieldPackageFilename(pkg), pkg);
    this.notify('现场包 JSON 已导出');
  }

  async removeDraft(packageId: string): Promise<void> {
    if (!confirm('确认删除本机该作业包草稿？未导出的登记将丢失。')) return;
    await this.desk.deleteDraft(packageId);
    if (this.activeDraft()?.packageId === packageId) this.activeDraft.set(null);
    await this.refreshDrafts();
  }

  kindLabel(kind: FieldPackage['facts'][number]['kind']): string {
    return kind === 'stepState' ? '步骤状态' : kind === 'reading' ? '测点读数' : '分步验收';
  }

  factText(fact: FieldPackage['facts'][number]): string {
    if (fact.kind === 'stepState') {
      return `#${fact.issuedSeq} → ${this.stepStateLabel[fact.state]} · ${fact.recordedAt} · ${fact.operator}`;
    }
    if (fact.kind === 'reading') {
      return `#${fact.issuedSeq} ${fact.pointCode} · 位移 ${fact.displacementMm}mm / 应力 ${fact.stressMpa}MPa · ${fact.recordedAt} · ${fact.operator}`;
    }
    return `${fact.issuedBearingLabel} · ${this.stageLabel[fact.stage]} / ${this.conclusionLabel[fact.conclusion]} · ${fact.acceptedAt} · ${fact.acceptor}`;
  }

  factId(fact: FieldPackage['facts'][number]): string {
    return fact.factId.slice(0, 18);
  }

  private notify(message: string): void {
    this.snackBar.open(message, '关闭', { duration: 2600 });
  }
}
