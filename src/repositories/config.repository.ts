/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * System configuration repository (key/value app settings, admin-managed).
 */

import { query } from '../db/pool.ts';
import type { SystemConfigRecord } from '../types/gogo.ts';

interface ConfigRow {
  config_key: string;
  config_value: string;
  description: string;
  updated_by: string;
  updated_at: Date;
}

function toRecord(row: ConfigRow): SystemConfigRecord {
  return {
    configKey: row.config_key,
    configValue: row.config_value,
    description: row.description,
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listSystemConfigs(): Promise<SystemConfigRecord[]> {
  const rows = await query<ConfigRow>(
    'SELECT config_key, config_value, description, updated_by, updated_at FROM system_configs ORDER BY config_key'
  );
  return rows.map(toRecord);
}

export async function getSystemConfig(configKey: string): Promise<SystemConfigRecord | null> {
  const rows = await query<ConfigRow>(
    'SELECT config_key, config_value, description, updated_by, updated_at FROM system_configs WHERE config_key = $1',
    [configKey]
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function updateSystemConfig(
  configKey: string,
  configValue: string,
  updatedBy: string
): Promise<SystemConfigRecord | null> {
  const rows = await query<{ config_key: string }>(
    `UPDATE system_configs SET config_value = $2, updated_by = $3, updated_at = NOW()
     WHERE config_key = $1 RETURNING config_key`,
    [configKey, configValue, updatedBy]
  );
  if (rows.length === 0) return null;
  return getSystemConfig(configKey);
}

/** Numeric config helper with default (e.g. fcm_max_retries, retention days). */
export async function getNumberConfig(configKey: string, fallback: number): Promise<number> {
  const config = await getSystemConfig(configKey);
  if (!config) return fallback;
  const parsed = Number(config.configValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}
