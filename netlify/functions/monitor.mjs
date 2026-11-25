import { getStore } from '@netlify/blobs';
import tower from '../lib/tower.js';
import lab from '../lib/lab.js';
export default async () => {
  await tower.runOnce(getStore('tower'), false, getStore('mt5-trading'));
  // M15 Lab berjalan terpisah; kegagalannya tidak boleh mengganggu Control Tower.
  try { await lab.runLab(getStore('lab'), getStore('tower'), getStore('mt5-trading'), false); } catch (e) { /* abaikan */ }
};
export const config = { schedule: '2,17,32,47 * * * *' };
