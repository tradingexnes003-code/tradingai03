//+------------------------------------------------------------------+
//| ExnessBridge.mq5                                                  |
//| Mengirim candle dari MT5 ke aplikasi Trading AI Monitor.          |
//| EA ini HANYA MEMBACA data. Tidak membuka, mengubah, atau menutup  |
//| order apa pun.                                                    |
//+------------------------------------------------------------------+
#property copyright "Trading AI Monitor"
#property version   "1.10"

input string ServerUrl     = "https://NAMA-SITUS-ANDA.netlify.app/.netlify/functions/ingest";
input string EaKey         = "ISI_DENGAN_EA_KEY";
input string SymbolList    = "BTCUSDm,BNBUSDm,ETHUSDm,XAUUSDm"; // simbol Gold akun pengguna, persis seperti Market Watch
input string TimeframeList = "M5,M15,H1,H4";
input int    FullBars      = 300;   // jumlah candle saat kirim penuh
input int    IntervalSec   = 5;     // jeda kirim (detik); 5 detik = pembaruan mendekati real-time

string   g_sym[];
string   g_tf[];
datetime g_last[];

ENUM_TIMEFRAMES ParseTF(const string s)
{
   if(s=="M1")  return PERIOD_M1;
   if(s=="M5")  return PERIOD_M5;
   if(s=="M15") return PERIOD_M15;
   if(s=="M30") return PERIOD_M30;
   if(s=="H1")  return PERIOD_H1;
   if(s=="H2")  return PERIOD_H2;
   if(s=="H4")  return PERIOD_H4;
   if(s=="D1")  return PERIOD_D1;
   return PERIOD_CURRENT;
}

bool Send(const string body)
{
   char   data[], res[];
   string rh;
   int n = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0) ArrayResize(data, n - 1);
   string headers = "Content-Type: application/json\r\nx-ea-key: " + EaKey + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", ServerUrl, headers, 15000, data, res, rh);
   if(code == -1)
   {
      Print("WebRequest gagal, error ", GetLastError(), ". Izinkan URL di Tools > Options > Expert Advisors.");
      return false;
   }
   if(code != 200)
   {
      Print("Server menjawab ", code, ": ", CharArrayToString(res, 0, WHOLE_ARRAY, CP_UTF8));
      return false;
   }
   return true;
}

int OnInit()
{
   int a = StringSplit(SymbolList, ',', g_sym);
   int b = StringSplit(TimeframeList, ',', g_tf);
   if(a <= 0 || b <= 0) return INIT_PARAMETERS_INCORRECT;
   for(int i = 0; i < a; i++)
   {
      StringTrimLeft(g_sym[i]);
      StringTrimRight(g_sym[i]);
      if(!SymbolSelect(g_sym[i], true)) Print("Simbol tidak ditemukan: ", g_sym[i]);
   }
   for(int j = 0; j < b; j++)
   {
      StringTrimLeft(g_tf[j]);
      StringTrimRight(g_tf[j]);
   }
   ArrayResize(g_last, a * b);
   ArrayInitialize(g_last, 0);
   EventSetTimer(IntervalSec);
   Print("ExnessBridge aktif: ", a, " simbol, ", b, " timeframe");
   OnTimer();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   int ns = ArraySize(g_sym), nt = ArraySize(g_tf);
   string body = "{\"d\":[";
   bool any = false;
   for(int i = 0; i < ns; i++)
   {
      string part = "";
      for(int j = 0; j < nt; j++)
      {
         ENUM_TIMEFRAMES tf = ParseTF(g_tf[j]);
         if(tf == PERIOD_CURRENT) continue;
         datetime cur = iTime(g_sym[i], tf, 0);
         if(cur == 0) continue;
         int idx  = i * nt + j;
         int want = (g_last[idx] != cur) ? FullBars : 3;
         MqlRates r[];
         ArraySetAsSeries(r, false);
         int got = CopyRates(g_sym[i], tf, 0, want, r);
         if(got <= 0) continue;
         int dg = (int)SymbolInfoInteger(g_sym[i], SYMBOL_DIGITS);
         string arr = "";
         for(int k = 0; k < got; k++)
         {
            if(k > 0) arr += ",";
            arr += "[" + (string)(long)r[k].time + "," + DoubleToString(r[k].open, dg) + "," + DoubleToString(r[k].high, dg) + ","
                   + DoubleToString(r[k].low, dg) + "," + DoubleToString(r[k].close, dg) + "]";
         }
         if(part != "") part += ",";
         part += "\"" + g_tf[j] + "\":[" + arr + "]";
         g_last[idx] = cur;
      }
      if(part == "") continue;
      if(any) body += ",";
      MqlTick tick;
      long quoteTime = SymbolInfoTick(g_sym[i], tick) ? (long)tick.time : 0;
      body += "{\"s\":\"" + g_sym[i] + "\",\"q\":" + (string)quoteTime + ",\"tf\":{" + part + "}}";
      any = true;
   }
   body += "]}";
   if(!any) return;
   if(!Send(body)) ArrayInitialize(g_last, 0); // gagal: kirim penuh lagi pada percobaan berikutnya
}
