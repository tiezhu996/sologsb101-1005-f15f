/**
 * 离线合并引擎端到端验证（Node + fake-indexeddb，不依赖浏览器）。
 * 覆盖：
 * 1. 发放→登记→合并：按稳定编号挂接，步骤重排不影响挂接（不按序号硬套）；
 * 2. 替换支座 / 撤去测点 → 待复核区并拦截归档；
 * 3. 同一包再次导入幂等，不重复生成读数 / 验收；
 * 4. 导入事务失败保留检查点，修复后重试成功；
 * 5. 主台账已有内容保留；步骤状态只向前推进。
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initDatabase,
  listBridges,
  listSteps,
  listReadings,
  listAcceptances,
  listReviewItems,
  listPoints,
  getImportCheckpoint,
  db,
} from '../frontend/src/app/core/utils/db';
import { issueFieldPackage, addReadingFact, addAcceptanceFact, addStepStateFact, sealPackage } from '../frontend/src/app/core/utils/field-package';
import { buildMergeContextIndex, planFieldPackageMerge, applyFieldPackageMerge } from '../frontend/src/app/core/utils/merge.engine';
import { FieldImportService } from '../frontend/src/app/core/services/field-import.service';
import { checkBridgeArchived } from '../frontend/src/app/core/store/archive.helper';
import { putSteps } from '../frontend/src/app/core/utils/db';
import { resequenceSteps } from '../frontend/src/app/core/types/step';

async function reset() {
  await db.delete();
  await db.open();
  await initDatabase();
}

test('full offline-merge lifecycle', async () => {
  await reset();
  const bridges = await listBridges();
  const bridge = bridges[0];

  // ---- 1. 主台账状态：步骤 + 测点 ----
  const stepsAll = await listSteps();
  const bridgeSteps = stepsAll.filter((s) => s.bridgeId === bridge.id);
  const arrived = bridgeSteps.find((s) => s.state === 'arrived')!;
  const lifting = bridgeSteps.find((s) => s.state === 'lifting')!;
  const pointsAll = await listPoints();
  const point = pointsAll.find((p) => p.stepId === arrived.id)!;

  const bearingsForBridge = (await import('../frontend/src/app/core/utils/db')).listBearings;
  const piersForBridge = (await import('../frontend/src/app/core/utils/db')).listPiers;
  const [allBearings, allPiers] = await Promise.all([bearingsForBridge(), piersForBridge()]);
  const pierIds = new Set(allPiers.filter((p) => p.bridgeId === bridge.id).map((p) => p.id));
  const bearings = allBearings.filter((b) => pierIds.has(b.pierId));
  const bearing = bearings[0];

  // ---- 2. 发放现场包 ----
  let pkg = issueFieldPackage({
    bridge,
    piers: allPiers.filter((p) => p.bridgeId === bridge.id),
    bearings,
    steps: bridgeSteps,
    points: pointsAll.filter((p) => bridgeSteps.some((s) => s.id === p.stepId)),
    issuedBy: '王工',
    deviceTag: '测试平板',
  });
  assert.equal(pkg.facts.length, 0);
  assert.ok(pkg.context.points.some((p) => p.id === point.id));

  // ---- 3. 平板登记：读数（对已到位步骤）、验收、步骤状态 ----
  const now = '2026-10-01 10:00';
  pkg = addReadingFact(pkg, {
    stepId: arrived.id,
    pointId: point.id,
    pointCode: point.pointCode,
    displacementMm: 8.12,
    stressMpa: 9.5,
    recordedAt: now,
    operator: '陈立强',
  });
  pkg = addAcceptanceFact(pkg, {
    bearingId: bearing.id,
    stage: 'completed',
    conclusion: 'pass',
    acceptor: '王监理',
    acceptedAt: now,
  });
  // 顶升中步骤推进到已到位
  pkg = addStepStateFact(pkg, {
    stepId: lifting.id,
    state: 'arrived',
    recordedAt: now,
    operator: '赵启明',
  });
  pkg = sealPackage(pkg);

  const readingsBefore = (await listReadings()).length;
  const accBefore = (await listAcceptances()).length;

  // ---- 4. 回项目部后：主台账重排步骤（颠倒顺序），稳定 id 不变 ----
  const reversedIds = [...bridgeSteps].sort((a, b) => b.seq - a.seq).map((s) => s.id);
  await putSteps(resequenceSteps(bridgeSteps, reversedIds));

  // 试合并：全部应按稳定编号挂接成功，无待复核
  const index1 = await buildMergeContextIndex();
  const plan1 = planFieldPackageMerge(pkg, index1);
  assert.equal(plan1.report.readingsApplied, 1, '读数按稳定步骤/测点编号挂接');
  assert.equal(plan1.report.acceptancesApplied, 1);
  assert.equal(plan1.report.stepStatesApplied, 1);
  assert.equal(plan1.report.reviewCreated, 0, '步骤重排不应产生待复核');
  assert.equal(plan1.report.blockedBridge, false);
  const readEntry = plan1.report.entries.find((e) => e.factKind === 'reading')!;
  assert.match(readEntry.detail, /8\.12/);

  const importer = new FieldImportService();
  const r1 = await importer.apply(pkg);
  assert.equal(r1.status, 'applied');
  assert.equal((await listReadings()).length, readingsBefore + 1, '主台账历史读数保留并新增 1 条');
  assert.equal((await listAcceptances()).length, accBefore + 1, '主台账历史验收保留并新增 1 条');
  const liftingAfter = (await listSteps()).find((s) => s.id === lifting.id)!;
  assert.equal(liftingAfter.state, 'arrived', '步骤状态按稳定 id 向前推进');

  // ---- 5. 同一包再次导入：幂等，不重复生成 ----
  const r2 = await importer.apply(pkg);
  assert.equal(r2.status, 'applied');
  assert.equal((await listReadings()).length, readingsBefore + 1, '重导不重复生成读数');
  assert.equal((await listAcceptances()).length, accBefore + 1, '重导不重复生成验收');
  // 用试算验证：已封包的包再跑计划，全部事实判为整包跳过
  const replan = planFieldPackageMerge(pkg, await buildMergeContextIndex());
  assert.equal(replan.report.duplicateFacts, 3, '整包标记已应用，事实全部跳过');
  assert.equal(replan.report.readingsApplied, 0);
  assert.equal(replan.report.acceptancesApplied, 0);
  assert.equal(replan.report.stepStatesApplied, 0);
  const cp = await getImportCheckpoint(pkg.packageId);
  assert.equal(cp?.status, 'applied');

  // ---- 6. 第二个包：主台账替换支座 + 撤去测点 → 待复核 + 拦截归档 ----
  let pkg2 = issueFieldPackage({
    bridge,
    piers: allPiers.filter((p) => p.bridgeId === bridge.id),
    bearings,
    steps: await listSteps().then((rows) => rows.filter((s) => s.bridgeId === bridge.id)),
    points: await listPoints(),
    issuedBy: '王工',
    deviceTag: '测试平板',
  });
  // 记录针对旧支座、已撤测点、不存在步骤的三类事实
  pkg2 = addAcceptanceFact(pkg2, {
    bearingId: bearing.id,
    stage: 'beamLowered',
    conclusion: 'pass',
    acceptor: '李总监',
    acceptedAt: now,
  });
  pkg2 = addReadingFact(pkg2, {
    stepId: arrived.id,
    pointId: point.id,
    pointCode: point.pointCode,
    displacementMm: 9.0,
    stressMpa: 10.0,
    recordedAt: now,
    operator: '陈立强',
  });
  const ghostStep = bridgeSteps.find((s) => s.id !== arrived.id && s.id !== lifting.id) ?? bridgeSteps[0];
  pkg2 = addStepStateFact(pkg2, {
    stepId: ghostStep.id,
    state: 'arrived',
    recordedAt: now,
    operator: '陈立强',
  });
  pkg2 = sealPackage(pkg2);

  // 主台账变化：删除旧支座（替换）、撤去测点、删除一个步骤
  const { removeBearing, retirePoint, removeStep, putBearing, newId, rowMeta } = await import('../frontend/src/app/core/utils/db');
  await retirePoint(point.id);
  await removeBearing(bearing.id);
  // 补一个“替换后”的新支座
  const firstPier = allPiers.find((p) => p.bridgeId === bridge.id)!;
  await putBearing({
    id: newId('bearing'),
    pierId: firstPier.id,
    serial: '新-1',
    type: 'pot',
    spec: 'GPZ 2500',
    diseaseGrade: 'intact',
    diseaseNote: '替换支座',
    ...rowMeta(),
  });
  await removeStep(ghostStep.id);

  const plan2 = planFieldPackageMerge(pkg2, await buildMergeContextIndex());
  assert.equal(plan2.report.reviewCreated, 3, '三类找不到归属事实全部进待复核');
  assert.equal(plan2.report.readingsApplied, 0);
  assert.equal(plan2.report.acceptancesApplied, 0);
  const reasons = plan2.reviewItems.map((i) => i.reason).sort();
  assert.deepEqual(reasons, ['bearing-missing', 'point-missing', 'step-missing']);
  assert.ok(plan2.reviewItems.every((i) => i.sourcePackageId === pkg2.packageId && i.bridgeName === bridge.name));

  await importer.apply(pkg2);
  const reviews = (await listReviewItems()).filter((r) => r.sourcePackageId === pkg2.packageId);
  assert.equal(reviews.length, 3);
  assert.ok(reviews.every((r) => r.status === 'open'));

  // ---- 7. 归档被拦截 ----
  const check = await checkBridgeArchived();
  const blocked = check.blockedByReview.find((b) => b.bridgeId === bridge.id);
  assert.ok(blocked, '存在未处理待复核时整桥不放行归档');
  assert.equal(blocked!.openCount, 3);

  // ---- 8. 处理待复核后归档放行（构造全部合格的桥）----
  const { updateReviewStatus } = await import('../frontend/src/app/core/utils/db');
  for (const r of reviews) await updateReviewStatus(r.id, 'resolved', '人工核销');
  const check2 = await checkBridgeArchived();
  assert.ok(!check2.blockedByReview.some((b) => b.bridgeId === bridge.id), '处理完不再拦截');

  // ---- 9. 步骤状态不回退：主台账已 arrived，现场旧包写 lifting 不应回退 ----
  let pkg3 = issueFieldPackage({
    bridge,
    piers: allPiers.filter((p) => p.bridgeId === bridge.id),
    bearings: [],
    steps: [{ ...lifting, state: 'arrived' }] as never,
    points: [],
    issuedBy: '王工',
    deviceTag: '测试平板',
  });
  // 手工构造一条回退事实（lifting < arrived）
  pkg3 = addStepStateFact(pkg3, { stepId: lifting.id, state: 'lifting', recordedAt: now, operator: 'X' });
  pkg3 = sealPackage(pkg3);
  await importer.apply(pkg3);
  const stillArrived = (await listSteps()).find((s) => s.id === lifting.id)!;
  assert.equal(stillArrived.state, 'arrived', '现场回退状态不得覆盖主台账');
});

test('failed transaction keeps checkpoint and retry succeeds after fix', async () => {
  await reset();
  const bridge = (await listBridges())[0];
  const steps = (await listSteps()).filter((s) => s.bridgeId === bridge.id);
  const step = steps[0];
  const point = (await listPoints()).find((p) => p.stepId === step.id)!;
  const { listBearings, listPiers } = await import('../frontend/src/app/core/utils/db');
  const [bearingsAll, piersAll] = await Promise.all([listBearings(), listPiers()]);
  const pierIds = new Set(piersAll.filter((p) => p.bridgeId === bridge.id).map((p) => p.id));

  let pkg = issueFieldPackage({
    bridge,
    piers: piersAll.filter((p) => p.bridgeId === bridge.id),
    bearings: bearingsAll.filter((b) => pierIds.has(b.pierId)),
    steps,
    points: (await listPoints()).filter((p) => steps.some((s) => s.id === p.stepId)),
    issuedBy: '王工',
    deviceTag: '测试平板',
  });
  pkg = addReadingFact(pkg, {
    stepId: step.id,
    pointId: point.id,
    pointCode: point.pointCode,
    displacementMm: 3.3,
    stressMpa: 8,
    recordedAt: '2026-10-01 11:00',
    operator: '陈',
  });
  pkg = sealPackage(pkg);

  // 首次导入：主台账缺少该测点 → 读数进待复核（这不是失败，是正常复核路径）
  const { removePoint } = await import('../frontend/src/app/core/utils/db');
  await removePoint(point.id);
  const importer = new FieldImportService();
  const plan = planFieldPackageMerge(pkg, await buildMergeContextIndex());
  assert.equal(plan.report.reviewCreated, 1);

  // 人为制造事务失败：在落账事务期间让 readings 表 put 抛错
  const originalPut = db.readings.put.bind(db.readings);
  db.readings.put = () => {
    throw new Error('disk quota simulated');
  };
  let threw = false;
  try {
    // 构造一个会写读数的计划：临时恢复测点后立即在抛错环境应用
    const { putPoint, rowMeta } = await import('../frontend/src/app/core/utils/db');
    await putPoint({ ...point, status: 'active' });
    await importer.apply(pkg);
  } catch (e) {
    threw = true;
    assert.match((e as Error).message, /disk quota/);
  } finally {
    db.readings.put = originalPut;
  }
  assert.ok(threw, '导入失败应向上抛错');
  const failedCp = await getImportCheckpoint(pkg.packageId);
  assert.equal(failedCp?.status, 'pending', '失败保留 pending 检查点');
  assert.ok((failedCp?.attempts ?? 0) >= 1);
  assert.match(failedCp!.lastError, /disk quota/);

  // 重试：此时测点已存在（active），事务恢复，成功
  const retry = await importer.retry(failedCp!.id);
  assert.equal(retry.status, 'applied');
  const okCp = await getImportCheckpoint(pkg.packageId);
  assert.equal(okCp?.status, 'applied');
  assert.equal(okCp?.lastError, '');

  // 再次重试 / 重导：幂等
  const again = await importer.retry(okCp!.id);
  assert.equal(again.status, 'applied');
});
