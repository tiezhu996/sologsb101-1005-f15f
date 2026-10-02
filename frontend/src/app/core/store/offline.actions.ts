/**
 * NgRx Actions：离线现场包相关的主台账维护
 * - 测点台账（新增 / 撤去 / 恢复 / 删除），由步骤编排页与现场作业页消费
 * - 待复核区（标记已处理 / 删除）
 * - 检查点（重试 / 放弃）动作仅触发副作用，状态经变更广播重载
 */
import { createActionGroup, emptyProps, props } from '@ngrx/store';
import type { MonitorPointDraft } from '../types/point';
import type { ReviewStatus } from '../types/merge';
import type { ImportCheckpointRow, PointRow, ReviewItemRow } from '../utils/db';

export const offlineActions = createActionGroup({
  source: 'offline',
  events: {
    'Load Success': props<{ points: PointRow[]; reviewItems: ReviewItemRow[]; checkpoints: ImportCheckpointRow[] }>(),

    /** 测点台账 */
    'Create Point': props<{ draft: MonitorPointDraft }>(),
    'Retire Point': props<{ id: string }>(),
    'Activate Point': props<{ id: string }>(),
    'Delete Point': props<{ id: string }>(),

    /** 待复核区 */
    'Resolve Review': props<{ id: string; resolution: string }>(),
    'Reopen Review': props<{ id: string }>(),
    'Delete Review': props<{ id: string }>(),

    /** 检查点 */
    'Retry Checkpoint': props<{ id: string }>(),
    'Abandon Checkpoint': props<{ id: string }>(),

    'Write Failure': props<{ error: string }>(),
    'Noop': emptyProps(),
  },
});

export type { ReviewStatus };
