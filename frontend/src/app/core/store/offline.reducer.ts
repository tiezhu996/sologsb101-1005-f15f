/**
 * 离线现场包 feature store：测点台账、待复核记录、导入检查点。
 * 数据全部随 appDataLoaded 全量分发，页面只通过 select 读取。
 */
import { createReducer, on } from '@ngrx/store';
import { appDataFailed, appDataLoaded } from './app.actions';
import { offlineActions } from './offline.actions';
import type { ImportCheckpointRow, PointRow, ReviewItemRow } from '../utils/db';

export interface OfflineState {
  points: PointRow[];
  reviewItems: ReviewItemRow[];
  checkpoints: ImportCheckpointRow[];
  loading: boolean;
  error: string;
}

export const initialOfflineState: OfflineState = {
  points: [],
  reviewItems: [],
  checkpoints: [],
  loading: false,
  error: '',
};

export const offlineReducer = createReducer(
  initialOfflineState,
  on(offlineActions.loadSuccess, (state, { points, reviewItems, checkpoints }) => ({
    ...state,
    loading: false,
    points,
    reviewItems,
    checkpoints,
  })),
  on(offlineActions.writeFailure, (state, { error }) => ({ ...state, error })),
  on(appDataLoaded, (state, { points, reviewItems, checkpoints }) => ({
    ...state,
    loading: false,
    error: '',
    points,
    reviewItems,
    checkpoints,
  })),
  on(appDataFailed, (state, { error }) => ({ ...state, loading: false, error })),
);
