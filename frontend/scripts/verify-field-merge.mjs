/**
 * 现场包离线合并引擎行为验证（不依赖浏览器）：
 * node --import tsx scripts/verify-field-merge.mjs 不可用时，本脚本自带 esbuild 编译。
 * 覆盖：稳定编号挂接（重排步骤）、替换支座 / 撤测点 → 待复核、幂等再导入、
 * 失败检查点重试、待复核闸门、主台账已有内容保留。
 */
import { build } from 'esbuild';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = '/workspace/frontend';

const entry = `
import 'fake-indexeddb/auto';
import {
  db,
  initDatabase,
  listReadings,
  listAcceptances,
  listBridges,
  listBearings,
  setPointActive,
  listFieldOrphans,
  listImportBatches,
  putStep,
  listSteps,
  removeBearing,
  resetDatabase,
} from '/workspace/frontend/src/app/core/utils/db';
import {
  buildFieldPackage,
  importFieldPackage,
  retryFailedImport,
  resolveReadingOrphan,
  discardOrphan,
} from '/workspace/frontend/src/app/core/utils/field-merge';
import { pointIdOf } from '/workspace/frontend/src/app/core/types/field-package';

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
  console.log('  ✓ ' + msg);
}

async function makeFactPackage(pkg, fact) {
  return {
    ...pkg,
    returnedAt: new Date().toISOString(),
    facts: {
      steps: [fact.step],
      readings: fact.readings,
      acceptances: fact.acceptances,
    },
  };
}

async function main() {
  await initDatabase();
  await resetDatabase();

  const bridges = await listBridges();
  assert(bridges.length === 2, '播种 2 座桥梁');
  const bridgeId = bridges[0].id;

  // 1) 发放
  const pkg = await buildFieldPackage({ bridgeId, deviceCode: 'tab-9' });
  assert(pkg.anchors.steps.length >= 2, '包内含步骤锚点（携带稳定 id 与展示 seq）');
  assert(pkg.anchors.points.length >= 1, '包内含测点锚点');
  assert(pkg.anchors.bearings.length >= 2, '包内含支座锚点');
  // 选一个「顶升中」的步骤做状态推进，选一个零验收的严重支座做验收事实
  const liftingAnchor = pkg.anchors.steps.find((a) => a.state === 'lifting');
  const firstStepId = liftingAnchor.stepId;
  const secondStepId = pkg.anchors.steps.find((a) => a.stepId !== firstStepId).stepId;
  const point = pkg.anchors.points.find((p) => p.stepId === firstStepId);
  const masterBearings = await listBearings();
  const accRows = await listAcceptances();
  const bearingWithNoAcc = masterBearings.find(
    (b) => b.diseaseGrade === 'severe' && !accRows.some((a) => a.bearingId === b.id),
  );
  const targetBearingId = bearingWithNoAcc.id;

  // 现场事实：读数挂在「顶升中」步骤的测点上（主台账随后会重排顺序）
  const returned = await makeFactPackage(pkg, {
    step: { factId: 'fs1', stepId: firstStepId, state: 'arrived', recordedAt: '2026-10-01 09:00', operator: '陈立强' },
    readings: [
      { factId: 'fr1', pointId: point.pointId, stepId: point.stepId, pointCode: point.pointCode, displacementMm: 3.21, stressMpa: 9.1, recordedAt: '2026-10-01 09:05', operator: '陈立强' },
      { factId: 'fr2', stepId: point.stepId, pointCode: 'PX', displacementMm: 2.8, stressMpa: 8.4, recordedAt: '2026-10-01 09:10', operator: '陈立强' },
    ],
    acceptances: [
      { factId: 'fa1', bearingId: targetBearingId, stage: 'lifted', conclusion: 'pass', acceptor: '王监理', acceptedAt: '2026-10-01 10:00' },
    ],
  });

  // 2) 回部前主台账重排步骤（该步骤与另一步骤互换 seq），读数仍应按稳定 id 落在原步骤
  let steps = await listSteps();
  const s1 = steps.find((s) => s.id === firstStepId);
  const s2 = steps.find((s) => s.id === secondStepId);
  await putStep({ ...s1, seq: s2.seq });
  await putStep({ ...s2, seq: s1.seq });
  steps = await listSteps();
  assert(steps.find((s) => s.id === firstStepId).seq !== liftingAnchor.seq, '主台账已重排：目标步骤展示序号已变');

  const readingsBefore = (await listReadings()).length;
  const accBefore = (await listAcceptances()).length;

  // 3) 导入
  const report = await importFieldPackage(returned, { fileName: 'r.json' });
  assert(report.stepsApplied === 1, '合并：1 条步骤状态推进');
  assert(report.readingsInserted === 2, '合并：2 条读数落库');
  assert(report.acceptancesInserted === 1, '合并：1 条验收落库');
  assert(report.pointsCreated === 1, '现场增设测点 PX 自动补登进测点台账');
  assert(report.orphansCreated === 0, '主台账结构未变（仅重排）时无待复核');

  const readingsAfter = await listReadings();
  const imported = readingsAfter.filter((r) => r.sourcePackageId === pkg.packageId);
  assert(imported.length === 2, '读数带来源包标记');
  assert(imported.every((r) => r.stepId === firstStepId), '读数按稳定 stepId 落位，未被重排后的 seq 带偏');
  const p1 = readingsAfter.find((r) => r.pointCode === point.pointCode && r.sourcePackageId === pkg.packageId);
  assert(p1.pointId === point.pointId, '读数按稳定 pointId 挂接');
  const stepsNow = await listSteps();
  assert(stepsNow.find((s) => s.id === firstStepId).state === 'arrived', '步骤状态已推进到已到位');
  assert(stepsNow.find((s) => s.id === firstStepId).seq !== liftingAnchor.seq, '主台账步骤顺序保持重排后状态（现场包不改 seq）');

  // 主台账原有读数 / 验收保留
  assert((await listReadings()).length === readingsBefore + 2, '主台账原有读数全部保留，仅增量新增');
  assert((await listAcceptances()).length === accBefore + 1, '主台账原有验收全部保留，仅增量新增');

  // 4) 同一包再次导入：幂等，不重复
  const report2 = await importFieldPackage(returned, { fileName: 'r.json' });
  assert(report2.duplicated === true, '重复导入识别为同一包，幂等短路');
  assert((await listReadings()).length === readingsAfter.length, '重复导入不新增读数');
  assert((await listAcceptances()).length === accBefore + 1, '重复导入不新增验收');

  // 5) 主台账撤去测点 + 替换支座：再来一包（同 packageId 会幂等，故造新包号）
  await setPointActive(point.pointId, false);
  // 替换支座：删旧 bearing（验收级联删除），新 bearing 新 id
  await removeBearing(targetBearingId);
  // 删除一个步骤，制造步骤孤儿
  // 用包内另一个步骤做步骤孤儿：改事实指向不存在步骤
  const orphanPkg = {
    ...pkg,
    packageId: pkg.packageId + '-round2',
    facts: {
      steps: [{ factId: 'fsx', stepId: 'step-gone', state: 'lifting', recordedAt: 'x', operator: 'x' }],
      readings: [
        { factId: 'frx', pointId: point.pointId, stepId: firstStepId, pointCode: point.pointCode, displacementMm: 1, stressMpa: 1, recordedAt: 'x', operator: 'x' },
      ],
      acceptances: [
        { factId: 'fax', bearingId: targetBearingId, stage: 'beamLowered', conclusion: 'pass', acceptor: 'x', acceptedAt: 'x' },
      ],
    },
  };
  const r3 = await importFieldPackage(orphanPkg, { fileName: 'r2.json' });
  assert(r3.orphansCreated === 3, '三类找不到归属的事实全部进入待复核区');
  const orphans = await listFieldOrphans();
  const pending = orphans.filter((o) => o.status === 'pending');
  assert(pending.length === 3, '待复核区 3 条 pending');
  assert(pending.some((o) => o.reason === 'step-missing'), '包含步骤缺失来源');
  assert(pending.some((o) => o.reason === 'point-retired'), '包含测点撤去来源');
  assert(pending.some((o) => o.reason === 'bearing-missing'), '包含支座替换来源');
  assert(pending.every((o) => o.deviceCode === 'tab-9' || o.packageId.includes('round2')), '待复核记录指认来源设备 / 包');

  // 已撤测点读数静默未落 readings 主表（没有新增该测点读数）
  const retiredHits = (await listReadings()).filter(
    (r) => r.pointId === point.pointId && r.sourcePackageId === orphanPkg.packageId,
  ).length;
  assert(retiredHits === 0, '撤点后的现场读数不静默落主表');

  // 5b) 包内 pointId 指向「别一步骤的同编号测点」时不得跨步骤误挂：
  //     该事实步骤上 PX 不存在 → 补登到本步骤，而不是挂到 pointId 原属步骤
  const otherStepId = pkg.anchors.steps.find((a) => a.stepId !== firstStepId && a.stepId !== secondStepId)?.stepId;
  if (otherStepId) {
    const crossPkg = {
      ...pkg,
      packageId: pkg.packageId + '-cross',
      facts: {
        steps: [],
        readings: [
          { factId: 'frc', pointId: pointIdOf(firstStepId, 'PX'), stepId: otherStepId, pointCode: 'PX', displacementMm: 4.4, stressMpa: 7.7, recordedAt: 'y', operator: 'y' },
        ],
        acceptances: [],
      },
    };
    const rc = await importFieldPackage(crossPkg, { fileName: 'c.json' });
    assert(rc.orphansCreated === 0 && rc.pointsCreated === 1, '跨步骤同编号测点不产生孤儿，在事实步骤补登测点');
    const rows = (await listReadings()).filter((r) => r.sourcePackageId === crossPkg.packageId);
    assert(rows.length === 1 && rows[0].stepId === otherStepId && rows[0].pointId === pointIdOf(otherStepId, 'PX'),
      '读数按事实步骤的派生 pointId 落位，未跨步骤误挂');
  }

  // 6) 归档闸门：待复核未处理，该桥不可归档（helper 层）
  const { checkBridgeArchived } = await import('/workspace/frontend/src/app/core/store/archive.helper');
  let check = await checkBridgeArchived();
  assert(!check.archivableBridgeIds.includes(bridgeId), '有待复核记录时不放行该桥归档');

  // 7) 复核处理：读数挂到另一步骤新测点；支座验收作废；步骤事实作废
  const readingOrphan = pending.find((o) => o.kind === 'reading');
  await resolveReadingOrphan({ orphanId: readingOrphan.id, targetStepId: secondStepId, targetPointCode: 'P9' });
  const moved = (await listReadings()).find((r) => r.id === 'read-fldorph-' + readingOrphan.id);
  assert(moved && moved.stepId === secondStepId && moved.pointCode === 'P9', '读数孤儿人工挂接到新步骤 / 测点');
  const accOrphan = pending.find((o) => o.kind === 'acceptance');
  await discardOrphan(accOrphan.id);
  const stepOrphan = pending.find((o) => o.kind === 'step');
  await discardOrphan(stepOrphan.id);
  const pendingLeft = (await listFieldOrphans()).filter((o) => o.status === 'pending');
  assert(pendingLeft.length === 0, '待复核全部处理（挂接 / 作废）');

  // 8) 失败检查点：导入指向不存在桥梁的包 → failed 批次，可重试
  const ghost = { ...pkg, packageId: 'fldpkg-ghost', bridgeId: 'bridge-nope', bridgeName: '幽灵桥' };
  let ghostErr = null;
  try {
    await importFieldPackage(ghost, { fileName: 'g.json' });
  } catch (e) {
    ghostErr = e;
  }
  assert(ghostErr, '桥梁不存在时导入报错');
  const batchesAfterFail = await listImportBatches();
  const cp = batchesAfterFail.find((b) => b.packageId === 'fldpkg-ghost');
  assert(cp && cp.status === 'failed' && cp.packageJson.includes('ghost'), '失败保留检查点（整包原文）');

  // 主台账恢复该桥后重试成功（补一座同 id 桥）
  const { putBridge } = await import('/workspace/frontend/src/app/core/utils/db');
  await putBridge({
    id: 'bridge-nope', name: '幽灵桥', spanCombo: '1×10m', bridgeType: 'beam', builtYear: 2020,
    roadClass: 'first', archived: false, createdAt: new Date().toISOString(), revision: 3,
  });
  // 该桥无步骤 / 支座：三条事实都会变孤儿（合理），但批次应成功
  const retryReport = await retryFailedImport('fldpkg-ghost');
  assert(retryReport && retryReport.orphansCreated >= 0, '检查点重试执行完成');
  const cp2 = (await listImportBatches()).find((b) => b.packageId === 'fldpkg-ghost');
  assert(cp2.status === 'succeeded', '重试成功后检查点转为成功批次');

  // 9) 格式错误不建检查点
  let fmtErr = null;
  try { await importFieldPackage({ hello: 1 }, {}); } catch (e) { fmtErr = e; }
  assert(fmtErr, '非现场包文件被拒绝');
  const noCp = (await listImportBatches()).some((b) => b.error && b.status === 'failed' && b.bridgeId === undefined);
  assert(!noCp, '结构非法文件不建立检查点');

  console.log('\\n全部断言通过');
  await db.delete();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
`;

const dir = mkdtempSync(join(ROOT, '.verify-tmp-'));
const entryPath = join(dir, 'verify.ts');
writeFileSync(entryPath, entry);

try {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    sourcemap: false,
    absWorkingDir: ROOT,
  });
  const outPath = join(dir, 'verify.mjs');
  writeFileSync(outPath, result.outputFiles[0].text);
  await import(pathToFileURL(outPath).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
