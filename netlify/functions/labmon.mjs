import { getStore } from '@netlify/blobs';
import lab from '../lib/lab.js';
// M15 Lab dijalankan tiap 5 menit supaya flip, TP, dan trailing terdeteksi segera setelah candle M15 tertutup dan dikirim EA
// (sebelumnya hanya pada menit 02/17/32/47 bersama Control Tower). Tidak ada candle baru = tidak ada pekerjaan; kunci proses mencegah tumpang tindih.
export default async () => {
  try { await lab.runLab(getStore('lab'), getStore('tower'), getStore('mt5-trading'), false); } catch (e) { /* abaikan */ }
};
export const config = { schedule: '*/5 * * * *' };
