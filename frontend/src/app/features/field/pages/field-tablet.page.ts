import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { ROUTES } from '../../../core/router/app.routes';
import { FieldSyncService } from '../../../core/services/field-sync.service';
import {
  type FieldAcceptanceFact,
  type FieldDraftRow,
  type FieldPackage,
  type FieldReadingFact,
  type FieldStepFact,
  fieldPackageFilename,
} from '../../../core/types/field-package';
import { STEP_STATES, STEP_STATE_LABEL, type StepState } from '../../../core/types/step';
import {
  ACCEPTANCE_CONCLUSIONS,
  ACCEPTANCE_CONCLUSION_LABEL,
  ACCEPTANCE_STAGES,
  ACCEPTANCE_STAGE_LABEL,
  type AcceptanceConclusion,
  type AcceptanceStage,
} from '../../../core/types/acceptance';
import { downloadJson, nowDateTime, readJsonFile } from '../../../core/utils/export';
import { StatBadgeComponent } from '../../../shared/components/common/stat-badge.component';
import { EmptyPanelComponent } from '../../../shared/components/common/empty-panel.component';

/**
 * /field/tablet 平板现场登记页（断网工作）：
 * 载入项目部发放包 → 本地草稿登记步骤状态 / 测点读数 / 分步验收（自动暂存 IndexedDB）
 * → 导出回填包带回项目部。包内只有执行事实与发放时的稳定编号，不携带主台账结构。
 */
@Component({
  selector: 'app-field-tablet-page',
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
    StatBadgeComponent,
    EmptyPanelComponent,
  ],
  template: `
    <div class="page-head">
      <div>
        <h2 class="page-title">平板现场登记（断网作业）</h2>
        <div class="page-sub">
          载入现场包后全部登记自动保存在本机；序号仅用于展示，读数按测点稳定编号记录，回部后由项目部离线合并。
        </div>
      </div>
      <div class="gb-inline-actions">
        <button mat-stroked-button (click)="go(ROUTES.field)">
          <mat-icon>sync_alt</mat-icon>
          回项目部合并页
        </button>
      </div>
    </div>

    @if (!pkg(); as _) {
      <mat-card appearance="outlined" class="gb-section">
        <div style="padding: 16px">
          <div class="gb-card-title">载入现场作业包</div>
          <div class="gb-hint" style="margin: 6px 0 12px">
            请选择项目部下发的 {{ '{' }}fldpkg-*.json{{ '}' }} 文件。本页无需联网，草稿只存在平板本机。
          </div>
          <label class="upload-label">
            <input type="file" accept="application/json" hidden (change)="handleOpen($event)" />
            <span mat-flat-button color="primary">
              <mat-icon>download_for_offline</mat-icon>
              选择现场包载入
            </span>
          </label>
          @if (drafts().length > 0) {
            <div style="margin-top: 16px">
              <div class="gb-card-title">本机未交回的草稿（{{ drafts().length }}）</div>
              <div class="gb-table-wrap" style="margin-top: 8px">
                <table class="gb-table">
                  <thead>
                    <tr><th>桥梁</th><th>包编号</th><th>登记进度</th><th>最近保存</th><th style="width: 120px">操作</th></tr>
                  </thead>
                  <tbody>
                    @for (draft of drafts(); track draft.packageId) {
                      <tr>
                        <td>{{ draft.bridgeId }}</td>
                        <td class="gb-mono">{{ short(draft.packageId) }}</td>
                        <td>{{ draft.steps.length }} 状态 · {{ draft.readings.length }} 读数 · {{ draft.acceptances.length }} 验收</td>
                        <td>{{ draft.updatedAt.slice(0, 16).replace('T', ' ') }}</td>
                        <td class="gb-hint">重新载入同名发放包即自动续上</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          }
        </div>
      </mat-card>
    } @else {
      <div class="stat-grid">
        <app-stat-badge title="步骤状态" [value]="draft()!.steps.length" [suffix]="'条'" color="#3949ab" />
        <app-stat-badge title="测点读数" [value]="draft()!.readings.length" [suffix]="'条'" color="#1565c0" />
        <app-stat-badge title="分步验收" [value]="draft()!.acceptances.length" [suffix]="'条'" color="#2e7d32" />
        <app-stat-badge title="设备标识" [value]="draft()!.deviceCode" color="#00897b" />
      </div>

      <mat-card appearance="outlined" class="gb-section">
        <div style="padding: 12px 14px">
          <div class="gb-card-title">{{ pkg()!.bridgeName }} · 包 {{ short(pkg()!.packageId) }}</div>
          <div class="gb-tags" style="margin-top: 6px">
            <mat-chip highlighted>发放 {{ pkg()!.issuedAt.slice(0, 16).replace('T', ' ') }}</mat-chip>
            <mat-chip>{{ pkg()!.anchors.steps.length }} 个步骤锚点</mat-chip>
            <mat-chip>{{ pkg()!.anchors.points.length }} 个测点锚点</mat-chip>
            <mat-chip>{{ pkg()!.anchors.bearings.length }} 个支座锚点</mat-chip>
          </div>
          <div class="gb-inline-actions" style="margin-top: 10px">
            <button mat-flat-button color="primary" (click)="exportReturned()">
              <mat-icon>upload_file</mat-icon>
              生成回填包交回项目部
            </button>
            <button mat-stroked-button (click)="closePackage()">
              <mat-icon>inventory_2</mat-icon>
              暂存并关闭
            </button>
          </div>
        </div>
      </mat-card>

      <!-- 步骤状态登记 -->
      <div class="gb-section">
        <div class="gb-card-title" style="margin-bottom: 8px">步骤状态登记（按稳定步骤编号）</div>
        <div class="gb-table-wrap">
          <table class="gb-table">
            <thead>
              <tr>
                <th>展示序号</th>
                <th>目标 / 限位</th>
                <th>发放时状态</th>
                <th style="width: 220px">现场回报状态</th>
                <th>已登记</th>
              </tr>
            </thead>
            <tbody>
              @for (anchor of pkg()!.anchors.steps; track anchor.stepId) {
                <tr>
                  <td>#{{ anchor.seq }} <span class="gb-hint">（仅展示）</span></td>
                  <td>{{ anchor.targetLiftMm }} / {{ anchor.limitMm }} mm</td>
                  <td>{{ stepStateLabel[anchor.state] }}</td>
                  <td>
                    <div class="gb-inline-actions" style="gap: 6px">
                      <mat-form-field appearance="outline" style="min-width: 130px">
                        <mat-select [ngModel]="stepDraftState(anchor.stepId)"
                          (ngModelChange)="setStepState(anchor.stepId, $event)">
                          @for (state of stepStates; track state) {
                            <mat-option [value]="state">{{ stepStateLabel[state] }}</mat-option>
                          }
                        </mat-select>
                      </mat-form-field>
                    </div>
                  </td>
                  <td>
                    @if (stepFact(anchor.stepId); as fact) {
                      <mat-chip highlighted class="stage-done">
                        {{ stepStateLabel[fact.state] }} · {{ fact.recordedAt.slice(5, 16) }}
                      </mat-chip>
                    } @else {
                      <span class="gb-hint">未登记</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      <!-- 测点读数登记 -->
      <div class="gb-section">
        <div class="gb-card-title" style="margin-bottom: 8px">测点读数登记</div>
        <mat-card appearance="outlined">
          <div style="padding: 12px 14px">
            <div class="gb-inline-actions">
              <mat-form-field appearance="outline" style="min-width: 240px">
                <mat-label>步骤 / 测点</mat-label>
                <mat-select [ngModel]="formPointId()" (ngModelChange)="formPointId.set($event)">
                  @for (anchor of pkg()!.anchors.points; track anchor.pointId) {
                    <mat-option [value]="anchor.pointId">
                      #{{ stepSeq(anchor.stepId) }} · {{ anchor.pointCode }}（{{ anchor.pointId }}）
                    </mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" style="min-width: 130px">
                <mat-label>位移 mm</mat-label>
                <input matInput type="number" step="0.01" [ngModel]="formDisplacement()"
                  (ngModelChange)="formDisplacement.set($event)" />
              </mat-form-field>
              <mat-form-field appearance="outline" style="min-width: 130px">
                <mat-label>应力 MPa</mat-label>
                <input matInput type="number" step="0.01" [ngModel]="formStress()"
                  (ngModelChange)="formStress.set($event)" />
              </mat-form-field>
              <mat-form-field appearance="outline" style="min-width: 150px">
                <mat-label>记录人</mat-label>
                <input matInput [ngModel]="formOperator()" (ngModelChange)="formOperator.set($event)" />
              </mat-form-field>
              <button mat-flat-button color="primary" [disabled]="!formPointId()" (click)="addReading()">
                <mat-icon>add</mat-icon> 登记读数
              </button>
            </div>
            <div class="gb-hint">时间默认取当前（{{ now() }}）；读数携带测点稳定编号，主台账重排步骤不影响落位。</div>
          </div>
        </mat-card>

        @if (draft()!.readings.length === 0) {
          <app-empty-panel title="尚未登记读数" description="选择测点锚点后录入位移与应力，自动保存到本机草稿。" icon="sensors" />
        } @else {
          <div class="gb-table-wrap" style="margin-top: 8px">
            <table class="gb-table">
              <thead>
                <tr><th>步骤序号(展示)</th><th>测点</th><th>位移 mm</th><th>应力 MPa</th><th>时间</th><th>记录人</th><th style="width: 80px"></th></tr>
              </thead>
              <tbody>
                @for (fact of draft()!.readings; track fact.factId) {
                  <tr>
                    <td>#{{ stepSeq(fact.stepId) }}</td>
                    <td class="gb-mono">{{ fact.pointCode }} <span class="gb-hint">({{ short(fact.pointId || '') }})</span></td>
                    <td>{{ fact.displacementMm }}</td>
                    <td>{{ fact.stressMpa }}</td>
                    <td>{{ fact.recordedAt }}</td>
                    <td>{{ fact.operator }}</td>
                    <td><button mat-button color="warn" (click)="removeReading(fact.factId)">删</button></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>

      <!-- 分步验收登记 -->
      <div class="gb-section">
        <div class="gb-card-title" style="margin-bottom: 8px">分步验收签署</div>
        <mat-card appearance="outlined">
          <div style="padding: 12px 14px">
            <div class="gb-inline-actions">
              <mat-form-field appearance="outline" style="min-width: 240px">
                <mat-label>支座</mat-label>
                <mat-select [ngModel]="formBearingId()" (ngModelChange)="formBearingId.set($event)">
                  @for (anchor of pkg()!.anchors.bearings; track anchor.bearingId) {
                    <mat-option [value]="anchor.bearingId">
                      {{ anchor.pierCode }} · {{ anchor.serial }} · {{ anchor.spec }}
                    </mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" style="min-width: 140px">
                <mat-label>分步</mat-label>
                <mat-select [ngModel]="formStage()" (ngModelChange)="formStage.set($event)">
                  @for (stage of stages; track stage) {
                    <mat-option [value]="stage">{{ stageLabel[stage] }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" style="min-width: 130px">
                <mat-label>结论</mat-label>
                <mat-select [ngModel]="formConclusion()" (ngModelChange)="formConclusion.set($event)">
                  @for (conclusion of conclusions; track conclusion) {
                    <mat-option [value]="conclusion">{{ conclusionLabel[conclusion] }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" style="min-width: 140px">
                <mat-label>验收人</mat-label>
                <input matInput [ngModel]="formAcceptor()" (ngModelChange)="formAcceptor.set($event)" />
              </mat-form-field>
              <button mat-flat-button color="primary" [disabled]="!formBearingId()" (click)="addAcceptance()">
                <mat-icon>fact_check</mat-icon> 签署
              </button>
            </div>
            <div class="gb-hint">同一支座同一分步重复签署只保留最新结论；交回后按支座稳定编号挂接。</div>
          </div>
        </mat-card>

        @if (draft()!.acceptances.length === 0) {
          <app-empty-panel title="尚未签署验收" description="选择支座锚点与分步后登记合格 / 不合格结论。" icon="fact_check" />
        } @else {
          <div class="gb-table-wrap" style="margin-top: 8px">
            <table class="gb-table">
              <thead>
                <tr><th>墩台 / 支座</th><th>分步</th><th>结论</th><th>验收人</th><th>时间</th><th style="width: 80px"></th></tr>
              </thead>
              <tbody>
                @for (fact of draft()!.acceptances; track fact.factId) {
                  <tr>
                    <td>{{ bearingLabel(fact.bearingId) }}</td>
                    <td>{{ stageLabel[fact.stage] }}</td>
                    <td>{{ conclusionLabel[fact.conclusion] }}</td>
                    <td>{{ fact.acceptor }}</td>
                    <td>{{ fact.acceptedAt }}</td>
                    <td><button mat-button color="warn" (click)="removeAcceptance(fact.factId)">删</button></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
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
    `,
  ],
})
export class FieldTabletPage {
  private readonly fieldSync = inject(FieldSyncService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly router = inject(Router);

  readonly ROUTES = ROUTES;
  readonly stepStates = STEP_STATES;
  readonly stepStateLabel = STEP_STATE_LABEL;
  readonly stages = ACCEPTANCE_STAGES;
  readonly stageLabel = ACCEPTANCE_STAGE_LABEL;
  readonly conclusions = ACCEPTANCE_CONCLUSIONS;
  readonly conclusionLabel = ACCEPTANCE_CONCLUSION_LABEL;

  readonly pkg = signal<FieldPackage | null>(null);
  readonly draft = signal<FieldDraftRow | null>(null);
  readonly drafts = signal<FieldDraftRow[]>([]);

  readonly formPointId = signal('');
  readonly formDisplacement = signal(0);
  readonly formStress = signal(8);
  readonly formOperator = signal('陈立强');
  readonly formBearingId = signal('');
  readonly formStage = signal<AcceptanceStage>('lifted');
  readonly formConclusion = signal<AcceptanceConclusion>('pass');
  readonly formAcceptor = signal('王监理');

  readonly now = signal(nowDateTime());

  constructor() {
    void this.reloadDrafts();
  }

  short(id: string): string {
    return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
  }

  stepSeq(stepId: string): number {
    return this.pkg()?.anchors.steps.find((item) => item.stepId === stepId)?.seq ?? 0;
  }

  bearingLabel(bearingId: string): string {
    const anchor = this.pkg()?.anchors.bearings.find((item) => item.bearingId === bearingId);
    return anchor ? `${anchor.pierCode} · ${anchor.serial} · ${anchor.spec}` : bearingId;
  }

  stepFact(stepId: string): FieldStepFact | undefined {
    return this.draft()?.steps.find((item) => item.stepId === stepId);
  }

  stepDraftState(stepId: string): StepState {
    return this.stepFact(stepId)?.state ?? (this.pkg()?.anchors.steps.find((item) => item.stepId === stepId)?.state ?? 'idle');
  }

  async reloadDrafts(): Promise<void> {
    const drafts = await this.fieldSync.listDrafts();
    this.drafts.set(drafts);
  }

  async handleOpen(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const parsed = await readJsonFile<FieldPackage>(file);
      const draft = await this.fieldSync.openPackage(parsed, 'tablet-01');
      this.pkg.set(parsed);
      this.draft.set(draft);
      this.formPointId.set(parsed.anchors.points[0]?.pointId ?? '');
      this.formBearingId.set(parsed.anchors.bearings[0]?.bearingId ?? '');
      this.notify(`已载入 ${parsed.bridgeName} 现场包，登记内容自动保存在本机`);
    } catch (error) {
      this.notify(error instanceof Error ? error.message : '现场包载入失败');
    }
  }

  async setStepState(stepId: string, state: StepState): Promise<void> {
    const draft = this.draft();
    const pkg = this.pkg();
    if (!draft || !pkg) return;
    const fact: FieldStepFact = {
      factId: this.stepFact(stepId)?.factId ?? this.fieldSync.newStepFactId(pkg.packageId),
      stepId,
      state,
      recordedAt: nowDateTime(),
      operator: this.formOperator(),
    };
    const next = this.fieldSync.upsertStepFact(draft, fact);
    await this.fieldSync.saveDraft(next);
    this.draft.set(next);
    this.notify(`步骤 #${this.stepSeq(stepId)} 状态已登记：${STEP_STATE_LABEL[state]}（已暂存本机）`);
  }

  async addReading(): Promise<void> {
    const draft = this.draft();
    const pkg = this.pkg();
    if (!draft || !pkg) return;
    const anchor = pkg.anchors.points.find((item) => item.pointId === this.formPointId());
    if (!anchor) return;
    const fact: FieldReadingFact = {
      factId: this.fieldSync.newReadingFactId(pkg.packageId),
      pointId: anchor.pointId,
      stepId: anchor.stepId,
      pointCode: anchor.pointCode,
      displacementMm: Number(this.formDisplacement()) || 0,
      stressMpa: Number(this.formStress()) || 0,
      recordedAt: nowDateTime(),
      operator: this.formOperator().trim() || '现场班组',
    };
    const next = this.fieldSync.upsertReadingFact(draft, fact);
    await this.fieldSync.saveDraft(next);
    this.draft.set(next);
    this.notify(`测点 ${anchor.pointCode} 读数已登记并暂存`);
  }

  async removeReading(factId: string): Promise<void> {
    const draft = this.draft();
    if (!draft) return;
    const next = { ...draft, readings: draft.readings.filter((item) => item.factId !== factId) };
    await this.fieldSync.saveDraft(next);
    this.draft.set(next);
  }

  async addAcceptance(): Promise<void> {
    const draft = this.draft();
    const pkg = this.pkg();
    if (!draft || !pkg) return;
    const fact: FieldAcceptanceFact = {
      factId: this.fieldSync.newAcceptanceFactId(pkg.packageId),
      bearingId: this.formBearingId(),
      stage: this.formStage(),
      conclusion: this.formConclusion(),
      acceptor: this.formAcceptor().trim() || '现场监理',
      acceptedAt: nowDateTime(),
    };
    const next = this.fieldSync.upsertAcceptanceFact(draft, fact);
    await this.fieldSync.saveDraft(next);
    this.draft.set(next);
    this.notify(`已签署 ${ACCEPTANCE_STAGE_LABEL[fact.stage]}：${ACCEPTANCE_CONCLUSION_LABEL[fact.conclusion]}`);
  }

  async removeAcceptance(factId: string): Promise<void> {
    const draft = this.draft();
    if (!draft) return;
    const next = { ...draft, acceptances: draft.acceptances.filter((item) => item.factId !== factId) };
    await this.fieldSync.saveDraft(next);
    this.draft.set(next);
  }

  async exportReturned(): Promise<void> {
    const draft = this.draft();
    const pkg = this.pkg();
    if (!draft || !pkg) return;
    if (draft.steps.length + draft.readings.length + draft.acceptances.length === 0) {
      this.notify('尚未登记任何执行事实');
      return;
    }
    const returned = await this.fieldSync.buildReturnedPackage(pkg, draft);
    downloadJson(fieldPackageFilename(returned).replace(/\.json$/, '-return.json'), returned);
    this.notify('回填包已生成，请交回项目部离线合并（草稿仍保留在本机）');
  }

  closePackage(): void {
    this.pkg.set(null);
    this.draft.set(null);
    void this.reloadDrafts();
  }

  go(path: string): void {
    void this.router.navigate([path]);
  }

  private notify(message: string): void {
    this.snackBar.open(message, '关闭', { duration: 2800 });
  }
}
