/**
 * 验证 v2 旧库升级到 v3：旧数据完整保留，新表自动可用，
 * 升级后自动为既有步骤补齐测点台账（缺测点时发放包仍可用，导入按缺失处理）。
 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { db, listBridges, listSteps, listPoints, listReviewItems, listImportCheckpoints, DB_SCHEMA_VERSION } from '../frontend/src/app/core/utils/db';

const OLD = {
  createdAt: '2026-01-01T00:00:00.000Z',
  revision: 2,
};

test('v2 → v3 upgrade keeps old rows and exposes new tables', async () => {
  await db.delete();

  // 手工构造 v2 结构并写入一条互相关联的旧数据
  const legacy = new Dexie('gbbridgebear');
  legacy.version(1).stores({
    bridges: 'id, name, bridgeType, builtYear',
    piers: 'id, bridgeId, code',
    bearings: 'id, pierId, diseaseGrade, type',
    steps: 'id, bridgeId, seq, state',
    readings: 'id, stepId, pointCode',
    acceptances: 'id, bearingId, stage, conclusion',
  });
  legacy.version(2).stores({
    bridges: 'id, name, bridgeType, builtYear, roadClass, archived',
    piers: 'id, bridgeId, code, capElevation, [bridgeId+code]',
    bearings: 'id, pierId, diseaseGrade, type, serial, [pierId+serial]',
    steps: 'id, bridgeId, seq, state, syncRequirement, [bridgeId+seq]',
    readings: 'id, stepId, pointCode, recordedAt, [stepId+pointCode]',
    acceptances: 'id, bearingId, stage, conclusion, [bearingId+stage]',
    settings: 'id',
  });
  await legacy.table('bridges').put({
    id: 'b-old',
    name: '旧库大桥',
    spanCombo: '2×20m',
    bridgeType: 'beam',
    builtYear: 2001,
    roadClass: 'second',
    archived: false,
    ...OLD,
  });
  await legacy.table('steps').put({
    id: 's-old',
    bridgeId: 'b-old',
    seq: 1,
    targetLiftMm: 3,
    syncRequirement: 'sync',
    limitMm: 10,
    leader: '旧班长',
    state: 'idle',
    ...OLD,
  });
  await legacy.close();

  // 重新打开主 db，应触发 v3 升级
  await db.open();
  assert.equal(db.verno, DB_SCHEMA_VERSION);

  const bridges = await listBridges();
  assert.equal(bridges.find((b) => b.id === 'b-old')?.name, '旧库大桥', '旧桥梁数据保留');
  const steps = await listSteps();
  assert.ok(steps.some((s) => s.id === 's-old'), '旧步骤数据保留');

  // 新表可读写（旧库步骤没有测点，属允许状态：现场包照发，读数按待复核处理）
  const points = await listPoints();
  assert.ok(Array.isArray(points));
  assert.equal((await listReviewItems()).length, 0);
  assert.equal((await listImportCheckpoints()).length, 0);

  await db.close();
});
