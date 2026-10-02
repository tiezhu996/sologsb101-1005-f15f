/**
 * 现场包发放与封包（纯前端、断网可用）。
 * - issueFieldPackage：按主台账当前归属（桥梁 / 墩台 / 支座 / 步骤顺序 / 测点台账）
 *   冻结一份只读快照，平板只在 facts 上登记执行事实。
 * - 挂接编号一律取实体稳定 id；步骤序号仅随快照留档，供人工核对。
 */
import {
  FIELD_PACKAGE_VERSION,
  type FieldFact,
  type FieldPackage,
  type IssuedBearing,
  type IssuedPoint,
  type IssuedStep,
} from '../types/field-package';
import type { AcceptanceConclusion, AcceptanceStage } from '../types/acceptance';
import type { StepState } from '../types/step';
import type { MonitorPoint } from '../types/point';
import type { Bridge } from '../types/bridge';
import type { Pier } from '../types/pier';
import type { Bearing } from '../types/bearing';
import type { Step } from '../types/step';
import { DB_SCHEMA_VERSION, newId } from './db';

/** 生成现场包 id */
export function newPackageId(): string {
  return `pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface IssueInput {
  bridge: Bridge;
  piers: Pier[];
  bearings: Bearing[];
  steps: Step[];
  points: MonitorPoint[];
  issuedBy: string;
  deviceTag: string;
}

/**
 * 发放现场包：冻结主台账快照，facts 初始为空。
 * 步骤按当前 seq 排序写入 issuedSeq，但现场登记只引用 step.id。
 */
export function issueFieldPackage(input: IssueInput, now: Date = new Date()): FieldPackage {
  const orderedSteps = [...input.steps].sort((a, b) => a.seq - b.seq);
  const pierMap = new Map(input.piers.map((pier) => [pier.id, pier]));

  const issuedBearings: IssuedBearing[] = input.bearings.map((bearing) => ({
    id: bearing.id,
    pierId: bearing.pierId,
    pierCode: pierMap.get(bearing.pierId)?.code ?? '-',
    serial: bearing.serial,
    spec: bearing.spec,
  }));

  const issuedSteps: IssuedStep[] = orderedSteps.map((step) => ({
    id: step.id,
    seq: step.seq,
    targetLiftMm: step.targetLiftMm,
    syncRequirement: step.syncRequirement,
    limitMm: step.limitMm,
    leader: step.leader,
    state: step.state,
  }));

  const stepIds = new Set(orderedSteps.map((step) => step.id));
  const issuedPoints: IssuedPoint[] = input.points
    .filter((point) => stepIds.has(point.stepId))
    .map((point) => ({
      id: point.id,
      stepId: point.stepId,
      pointCode: point.pointCode,
      location: point.location,
    }));

  return {
    kind: 'gbbridgebear-field-package',
    packageVersion: FIELD_PACKAGE_VERSION,
    packageId: newPackageId(),
    issuedAt: now.toISOString(),
    issuedBy: input.issuedBy,
    schemaVersion: DB_SCHEMA_VERSION,
    bridge: { id: input.bridge.id, name: input.bridge.name },
    context: {
      piers: input.piers.map((pier) => ({
        id: pier.id,
        bridgeId: pier.bridgeId,
        code: pier.code,
        type: pier.type,
      })),
      bearings: issuedBearings,
      steps: issuedSteps,
      points: issuedPoints,
    },
    facts: [],
    deviceTag: input.deviceTag,
    sealedAt: '',
  };
}

/** 追加一条步骤状态事实（幂等：同包同步骤只保留最新一条） */
export function addStepStateFact(
  pkg: FieldPackage,
  input: { stepId: string; state: StepState; recordedAt: string; operator: string; note?: string },
): FieldPackage {
  const issued = pkg.context.steps.find((step) => step.id === input.stepId);
  if (!issued) return pkg;
  const facts = pkg.facts.filter(
    (fact) => !(fact.kind === 'stepState' && fact.stepId === input.stepId),
  );
  facts.push({
    kind: 'stepState',
    factId: newId('fact-state'),
    stepId: input.stepId,
    issuedSeq: issued.seq,
    state: input.state,
    recordedAt: input.recordedAt,
    operator: input.operator,
    note: input.note ?? '',
  });
  return { ...pkg, facts };
}

/** 追加一条测点读数事实 */
export function addReadingFact(
  pkg: FieldPackage,
  input: {
    stepId: string;
    pointId: string;
    pointCode: string;
    displacementMm: number;
    stressMpa: number;
    recordedAt: string;
    operator: string;
  },
): FieldPackage {
  const issued = pkg.context.steps.find((step) => step.id === input.stepId);
  if (!issued) return pkg;
  const facts: FieldFact[] = [
    ...pkg.facts,
    {
      kind: 'reading',
      factId: newId('fact-read'),
      stepId: input.stepId,
      issuedSeq: issued.seq,
      pointId: input.pointId,
      pointCode: input.pointCode,
      displacementMm: input.displacementMm,
      stressMpa: input.stressMpa,
      recordedAt: input.recordedAt,
      operator: input.operator,
    },
  ];
  return { ...pkg, facts };
}

/** 追加一条分步验收事实 */
export function addAcceptanceFact(
  pkg: FieldPackage,
  input: {
    bearingId: string;
    stage: AcceptanceStage;
    conclusion: AcceptanceConclusion;
    acceptor: string;
    acceptedAt: string;
    note?: string;
  },
): FieldPackage {
  const issued = pkg.context.bearings.find((bearing) => bearing.id === input.bearingId);
  if (!issued) return pkg;
  const facts: FieldFact[] = [
    ...pkg.facts,
    {
      kind: 'acceptance',
      factId: newId('fact-acc'),
      bearingId: input.bearingId,
      issuedBearingLabel: `${issued.pierCode} · ${issued.serial}`,
      stage: input.stage,
      conclusion: input.conclusion,
      acceptor: input.acceptor,
      acceptedAt: input.acceptedAt,
      note: input.note ?? '',
    },
  ];
  return { ...pkg, facts };
}

/** 删除包内一条事实（登记阶段平板可自行订正） */
export function removeFact(pkg: FieldPackage, factId: string): FieldPackage {
  return { ...pkg, facts: pkg.facts.filter((fact) => fact.factId !== factId) };
}

/** 封包：回项目部前冻结，不允许再追加事实 */
export function sealPackage(pkg: FieldPackage, now: Date = new Date()): FieldPackage {
  return { ...pkg, sealedAt: now.toISOString() };
}
