//+------------------------------------------------------------------+
//| AI_Exness_Bot.mq5                                                 |
//| Secure command bridge for Exness MT5. Demo-only by default.       |
//| Orders are NEVER sent unless EnableExecution=true.                |
//+------------------------------------------------------------------+
#property strict
#property version "1.71"
#property description "AI Exness Bot - controlled execution bridge; demo-only by default"

#include <Trade/Trade.mqh>
CTrade trade;

input string ServerBaseUrl       = "https://NAMA-SITUS-ANDA.netlify.app/.netlify/functions";
input string EaKey               = "GANTI_DENGAN_EA_KEY_ACAK";
input bool   EnableExecution     = false; // MUST remain false until demo tests are complete
input bool   AllowLiveAccount    = false; // false = reject all non-demo accounts
input double MaxRiskPct          = 10.00; // hard EA cap, percent of equity (maks 10% per trade)
input string SpecSymbols         = "BTCUSDm,BNBUSDm,ETHUSDm,XAUUSDm"; // simbol (persis seperti Market Watch) yang spesifikasi lotnya dilaporkan ke dashboard
input bool   AllowMinLotOverBudget = true;  // jika lot minimum broker melebihi anggaran risiko, pakai lot minimum asal risiko aktual <= MaxRiskPctWithMinLot (bukan ditolak)
input double MaxRiskPctWithMinLot  = 10.0;   // plafon keras risiko aktual (% ekuitas) saat dipaksa memakai lot minimum; di atas ini order tetap ditolak
input int    MaxSpreadPoints     = 0;     // batas keras spread dalam point; 0 = nonaktif (angka tetap tidak cocok untuk semua simbol)
input double MaxSpreadPctOfSL    = 15.0;  // tolak order jika spread melebihi persen ini dari jarak entry ke SL; 0 = nonaktif
input int    MaxEntryDistancePoints = 500; // mode NEAR: tolak entry yang terlalu jauh dari harga (0 = tanpa batas)
input int    PlanMaxDistancePoints  = 0;   // mode PLAN H1: batas jarak entry dari harga; 0 = tanpa batas (entry di zona jauh tidak ditolak)
input int    PlanExpirySeconds      = 14400; // mode PLAN H1: pending LIMIT kedaluwarsa otomatis (default 4 jam)
input double MaxSlCostPct       = 50.0;  // mode BIAYA-SL: plafon keras kerugian jika SL kena pada lot minimum (% ekuitas); di atas ini order ditolak
input int    MarketMaxDriftPoints = 0;    // mode MARKET (M15 siap -> langsung masuk): tolak jika harga pasar sudah bergeser sejauh ini dari harga sinyal; 0 = nonaktif (R:R dihitung ulang dari harga pasar)
input int    MaxQuoteAgeSeconds  = 30;
input double MinRiskReward       = 1.20;
input int    DeviationPoints     = 20;
input int    PollSeconds          = 3;
input long   MagicNumber          = 20261120;
input int    MaxActiveOrders      = 1;
input bool   ReportAccount        = true;
input int    MaxTotalActive       = 1;    // total posisi + order aktif milik EA ini
input double MaxDailyLossPct      = 25.0;  // blokir order baru jika ekuitas turun sebesar ini dari awal hari (GMT)
input int    PendingExpirySeconds = 7200; // pending limit kedaluwarsa otomatis
input bool   DryRun               = true; // true = validasi penuh dan hitung lot, tetapi TIDAK mengirim order

ulong g_last_report=0;

string Trim(string s){ StringTrimLeft(s); StringTrimRight(s); return s; }

bool Http(const string method,const string url,const string body,string &answer)
{
   char data[],result[]; string result_headers;
   ArrayResize(data,0);
   if(method=="POST") { int n=StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8); if(n>0) ArrayResize(data,n-1); }
   string headers="Content-Type: application/json\r\nx-ea-key: "+EaKey+"\r\n";
   ResetLastError();
   int code=WebRequest(method,url,headers,10000,data,result,result_headers);
   if(code==-1){ Print("WebRequest error ",GetLastError(),". Tambahkan domain Netlify ke Tools > Options > Expert Advisors > Allow WebRequest."); return false; }
   answer=CharArrayToString(result,0,WHOLE_ARRAY,CP_UTF8);
   if(code<200 || code>=300){ Print("HTTP ",code,": ",answer); return false; }
   return true;
}

int VolumeDigits(double step)
{
   int d=0; while(d<8 && MathAbs(step-NormalizeDouble(step,d))>1e-9) d++; return d;
}

int ActiveForSymbol(const string symbol)
{
   int count=0;
   for(int i=0;i<PositionsTotal();i++) { string s=PositionGetSymbol(i); if(s==symbol) count++; }
   for(int j=0;j<OrdersTotal();j++) { ulong ticket=OrderGetTicket(j); if(ticket>0 && OrderGetString(ORDER_SYMBOL)==symbol) count++; }
   return count;
}

int TotalActive()
{
   int c=0;
   for(int i=0;i<PositionsTotal();i++){ ulong t=PositionGetTicket(i); if(t>0 && PositionGetInteger(POSITION_MAGIC)==MagicNumber) c++; }
   for(int j=0;j<OrdersTotal();j++){ ulong t=OrderGetTicket(j); if(t>0 && OrderGetInteger(ORDER_MAGIC)==MagicNumber) c++; }
   return c;
}

double DayStartEquity()
{
   string key="AIEX_DAYEQ_"+TimeToString(TimeGMT(),TIME_DATE);
   if(!GlobalVariableCheck(key)) GlobalVariableSet(key,AccountInfoDouble(ACCOUNT_EQUITY));
   return GlobalVariableGet(key);
}

double RiskPctOf(const string symbol,const ENUM_ORDER_TYPE type,const double price,const double sl,const double vol)
{
   double eq=AccountInfoDouble(ACCOUNT_EQUITY), loss=0;
   if(eq<=0 || vol<=0 || !OrderCalcProfit(type,symbol,vol,price,sl,loss)) return 0;
   return MathAbs(loss)/eq*100.0;
}
double CalcVolume(const string symbol,const ENUM_ORDER_TYPE type,const double price,const double sl,const double riskPct)
{
   double equity=AccountInfoDouble(ACCOUNT_EQUITY), riskMoney=equity*riskPct/100.0;
   double loss=0;
   if(equity<=0 || riskMoney<=0 || !OrderCalcProfit(type,symbol,1.0,price,sl,loss)) return 0;
   double perLot=MathAbs(loss); if(perLot<=0) return 0;
   double vmin=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN), vmax=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX), step=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
   if(step<=0 || vmin<=0) return 0;
   double raw=MathMin(vmax,riskMoney/perLot);
   // Always round DOWN so the calculated risk does not exceed the requested budget.
   double vol=MathFloor(raw/step+1e-9)*step;
   if(vol<vmin)
   {
      // Lot minimum broker lebih besar dari anggaran risiko. Hanya boleh dinaikkan ke lot minimum jika diizinkan dan risiko aktualnya masih di bawah plafon keras.
      if(!AllowMinLotOverBudget) return 0;
      if(vmin*perLot > equity*MaxRiskPctWithMinLot/100.0) return 0;
      return NormalizeDouble(vmin,VolumeDigits(step));
   }
   return NormalizeDouble(vol,VolumeDigits(step));
}

void Ack(const string id,const string status,const string ticket,const string message)
{
   string safe=message; StringReplace(safe,"\\","\\\\"); StringReplace(safe,"\"","\\\"");
   string body="{\"action\":\"ack\",\"id\":\""+id+"\",\"status\":\""+status+"\",\"ticket\":\""+ticket+"\",\"message\":\""+safe+"\"}";
   string out; Http("POST",ServerBaseUrl+"/mt5-command",body,out);
}

// Pembatalan pending order milik EA (hanya ORDER pending, tidak pernah menyentuh posisi yang sudah terisi). ticket=0 -> semua pending EA untuk simbol itu.
void ProcessCancel(const string id,const string symbol,const ulong ticket)
{
   if(!EnableExecution){ Ack(id,"BLOCKED","","EA EnableExecution=false"); return; }
   long mode=AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(!AllowLiveAccount && mode!=ACCOUNT_TRADE_MODE_DEMO){ Ack(id,"BLOCKED","","Akun bukan DEMO; AllowLiveAccount=false"); return; }
   if(!DryRun && (!TerminalInfoInteger(TERMINAL_CONNECTED) || !MQLInfoInteger(MQL_TRADE_ALLOWED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))){ Ack(id,"BLOCKED","","Terminal/koneksi/Algo Trading tidak mengizinkan trading"); return; }
   int found=0,done=0;
   trade.SetExpertMagicNumber(MagicNumber);
   for(int j=OrdersTotal()-1;j>=0;j--)
   {
      ulong t=OrderGetTicket(j); if(t==0) continue;
      if(OrderGetInteger(ORDER_MAGIC)!=MagicNumber || OrderGetString(ORDER_SYMBOL)!=symbol) continue;
      if(ticket>0 && t!=ticket) continue;
      found++;
      if(DryRun) continue;
      if(trade.OrderDelete(t)) done++;
   }
   if(DryRun){ Ack(id,"DRYRUN","","Pembatalan tervalidasi: "+IntegerToString(found)+" pending order akan dihapus (DryRun=true, tidak dihapus)"); return; }
   if(found==0){ Ack(id,"CANCELLED","","Tidak ada pending order (sudah terisi atau kedaluwarsa)"); return; }
   Ack(id,(done==found?"CANCELLED":"FAILED"),"",IntegerToString(done)+"/"+IntegerToString(found)+" pending order dihapus");
}

// Menutup POSISI terbuka milik EA (magic number sama) untuk satu simbol, dipakai saat sinyal God 62 berbalik. Tidak pernah membuka order baru; aman diulang.
void ProcessClose(const string id,const string symbol)
{
   if(!EnableExecution){ Ack(id,"BLOCKED","","EA EnableExecution=false"); return; }
   long mode=AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(!AllowLiveAccount && mode!=ACCOUNT_TRADE_MODE_DEMO){ Ack(id,"BLOCKED","","Akun bukan DEMO; AllowLiveAccount=false"); return; }
   if(!DryRun && (!TerminalInfoInteger(TERMINAL_CONNECTED) || !MQLInfoInteger(MQL_TRADE_ALLOWED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))){ Ack(id,"BLOCKED","","Terminal/koneksi/Algo Trading tidak mengizinkan trading"); return; }
   int found=0,done=0;
   trade.SetExpertMagicNumber(MagicNumber); trade.SetDeviationInPoints(DeviationPoints); trade.SetTypeFillingBySymbol(symbol);
   for(int j=PositionsTotal()-1;j>=0;j--)
   {
      ulong t=PositionGetTicket(j); if(t==0) continue;
      if(PositionGetInteger(POSITION_MAGIC)!=MagicNumber || PositionGetString(POSITION_SYMBOL)!=symbol) continue;
      found++;
      if(DryRun) continue;
      if(trade.PositionClose(t)) done++;
   }
   if(DryRun){ Ack(id,"DRYRUN","","Penutupan tervalidasi: "+IntegerToString(found)+" posisi akan ditutup (DryRun=true, tidak ditutup)"); return; }
   if(found==0){ Ack(id,"CLOSED","","Tidak ada posisi terbuka (sudah selesai)"); return; }
   Ack(id,(done==found?"CLOSED":"FAILED"),"",IntegerToString(done)+"/"+IntegerToString(found)+" posisi ditutup");
}

void ProcessCommand(const string line)
{
   string p[]; int n=StringSplit(line,'|',p);
   if(n<7) return;
   string flag=(n>=8 ? Trim(p[7]) : "");
   bool planMode=(StringFind(flag,"P")>=0), marketMode=(StringFind(flag,"M")>=0), slMode=(StringFind(flag,"S")>=0);
   string id=Trim(p[0]), symbol=Trim(p[1]), side=Trim(p[2]);
   double entry=StringToDouble(p[3]), sl=StringToDouble(p[4]), tp=StringToDouble(p[5]), riskPct=StringToDouble(p[6]);
   if(id!="" && symbol!="" && side=="CANCEL"){ ProcessCancel(id,symbol,(ulong)StringToInteger(p[3])); return; }
   if(id!="" && symbol!="" && side=="CLOSE"){ ProcessClose(id,symbol); return; }
   if(id=="" || symbol=="" || (side!="BUY" && side!="SELL")){ Print("Command invalid: ",line); return; }
   if(!EnableExecution){ Ack(id,"BLOCKED","","EA EnableExecution=false"); return; }
   long mode=AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(!AllowLiveAccount && mode!=ACCOUNT_TRADE_MODE_DEMO){ Ack(id,"BLOCKED","","Akun bukan DEMO; AllowLiveAccount=false"); return; }
   if(riskPct<=0 || (!slMode && riskPct>MaxRiskPct)){ Ack(id,"BLOCKED","","RiskPct melebihi batas EA"); return; }
   double eqNow=AccountInfoDouble(ACCOUNT_EQUITY), eq0=DayStartEquity();
   if(eq0>0 && eqNow<=eq0*(1.0-MaxDailyLossPct/100.0)){ Ack(id,"BLOCKED","","Batas rugi harian EA tercapai; order baru diblokir hari ini"); return; }
   if(TotalActive()>=MaxTotalActive){ Ack(id,"BLOCKED","","Batas total posisi/order aktif EA tercapai"); return; }
   if(!TerminalInfoInteger(TERMINAL_CONNECTED) || !MQLInfoInteger(MQL_TRADE_ALLOWED) || !TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)) { Ack(id,"BLOCKED","","Terminal/koneksi/Algo Trading tidak mengizinkan trading"); return; }
   if(!SymbolSelect(symbol,true)){ Ack(id,"REJECTED","","Simbol tidak tersedia di Market Watch: "+symbol); return; }
   if(ActiveForSymbol(symbol)>=MaxActiveOrders){ Ack(id,"BLOCKED","","Batas posisi/order aktif untuk simbol ini tercapai"); return; }
   MqlTick tick; if(!SymbolInfoTick(symbol,tick)){ Ack(id,"REJECTED","","Tick harga tidak tersedia"); return; }
   double point=SymbolInfoDouble(symbol,SYMBOL_POINT);
   if(point<=0 || tick.ask<=0 || tick.bid<=0 || tick.ask<tick.bid){ Ack(id,"REJECTED","","Spesifikasi simbol atau quote tidak valid"); return; }
   if(tick.time<=0 || TimeCurrent()-(datetime)tick.time>MaxQuoteAgeSeconds){ Ack(id,"BLOCKED","","Quote MT5 kedaluwarsa; order dibatalkan untuk mencegah harga sumber lama"); return; }
   double spreadPrice=tick.ask-tick.bid, spread=spreadPrice/point;
   if(MaxSpreadPoints>0 && spread>MaxSpreadPoints){ Ack(id,"BLOCKED","","Spread "+DoubleToString(spread,0)+" point melebihi batas keras MaxSpreadPoints="+(string)MaxSpreadPoints); return; }
   double slDist0=MathAbs(entry-sl);
   if(MaxSpreadPctOfSL>0 && slDist0>0 && spreadPrice>slDist0*MaxSpreadPctOfSL/100.0){ Ack(id,"BLOCKED","","Spread terlalu besar: "+DoubleToString(spreadPrice/slDist0*100.0,1)+"% dari jarak SL (batas "+DoubleToString(MaxSpreadPctOfSL,1)+"%)"); return; }
   int digits=(int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   entry=NormalizeDouble(entry,digits); sl=NormalizeDouble(sl,digits); tp=NormalizeDouble(tp,digits);
   ENUM_ORDER_TYPE type=(side=="BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);
   double price=entry, refEntry=entry;
   if(marketMode)
   {
      price=NormalizeDouble((side=="BUY" ? tick.ask : tick.bid),digits); entry=price;
      if(MarketMaxDriftPoints>0 && MathAbs(price-refEntry)>MarketMaxDriftPoints*point){ Ack(id,"BLOCKED","","Harga pasar sudah bergeser dari harga sinyal M15 (melebihi MarketMaxDriftPoints); order market dibatalkan"); return; }
   }
   double stopLevel=SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL)*point;
   double freezeLevel=SymbolInfoInteger(symbol,SYMBOL_TRADE_FREEZE_LEVEL)*point;
   double minGap=MathMax(stopLevel,freezeLevel);
   double rrRisk=MathAbs(entry-sl), rrReward=(side=="BUY" ? tp-entry : entry-tp);
   if(rrRisk<=0 || rrReward<=0 || rrReward/rrRisk<MinRiskReward){ Ack(id,"REJECTED","","R:R di bawah batas minimum atau SL/TP tidak valid"); return; }
   if(marketMode && (side=="BUY" ? !(sl<price && price<tp) : !(tp<price && price<sl))){ Ack(id,"REJECTED","","Order MARKET tidak valid: SL/TP berada di sisi yang salah dari harga pasar saat ini"); return; }
   if(!marketMode && side=="BUY" && !(sl<entry && entry<tp && entry<tick.ask)){ Ack(id,"REJECTED","","BUY LIMIT tidak valid terhadap harga MT5 terkini; perlu SL < entry < TP dan entry di bawah Ask"); return; }
   if(!marketMode && side=="SELL" && !(tp<entry && entry<sl && entry>tick.bid)){ Ack(id,"REJECTED","","SELL LIMIT tidak valid terhadap harga MT5 terkini; perlu TP < entry < SL dan entry di atas Bid"); return; }
   double entryGap=(side=="BUY" ? tick.ask-entry : entry-tick.bid);
   long maxDist=(planMode ? PlanMaxDistancePoints : MaxEntryDistancePoints);
   if(!marketMode && maxDist>0 && entryGap>maxDist*point){ Ack(id,"BLOCKED","","Harga entry terlalu jauh dari quote MT5 terkini; kemungkinan data/sumber harga sudah berubah. Buat analisa baru"); return; }
   if((!marketMode && entryGap<minGap) || MathAbs(price-sl)<minGap || MathAbs(tp-price)<minGap){ Ack(id,"REJECTED","","Entry atau SL/TP terlalu dekat menurut stop/freeze level broker"); return; }
   double volume=0;
   if(slMode)
   {
      // Mode biaya-SL: selalu lot minimum. Syarat: kerugian jika SL kena <= MaxSlCostPct ekuitas, dan margin bebas cukup.
      double vminS=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN), stepS=SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
      if(vminS<=0 || stepS<=0){ Ack(id,"REJECTED","","Spesifikasi lot simbol tidak valid"); return; }
      volume=NormalizeDouble(vminS,VolumeDigits(stepS));
      double pctS=RiskPctOf(symbol,type,price,sl,volume), eqS=AccountInfoDouble(ACCOUNT_EQUITY);
      if(pctS<=0){ Ack(id,"REJECTED","","Gagal menghitung biaya SL"); return; }
      if(pctS>MaxSlCostPct){ Ack(id,"REJECTED","","Biaya SL "+DoubleToString(pctS,1)+"% ekuitas melebihi plafon EA MaxSlCostPct="+DoubleToString(MaxSlCostPct,1)+"%; butuh ekuitas minimal sekitar "+DoubleToString(eqS*pctS/MaxSlCostPct,2)); return; }
      double mgS=0; if(!OrderCalcMargin(type,symbol,volume,price,mgS) || mgS>AccountInfoDouble(ACCOUNT_MARGIN_FREE)){ Ack(id,"REJECTED","","Margin bebas tidak cukup untuk lot minimum (butuh "+DoubleToString(mgS,2)+", tersedia "+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2)+")"); return; }
   }
   else volume=CalcVolume(symbol,type,price,sl,riskPct);
   if(!slMode && volume<=0)
   {
      double vminR=SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN), minPct=RiskPctOf(symbol,type,price,sl,vminR);
      Ack(id,"REJECTED","","Lot minimum "+DoubleToString(vminR,2)+" berisiko "+DoubleToString(minPct,2)+"% ekuitas, di atas plafon "+DoubleToString(MathMax(riskPct,AllowMinLotOverBudget?MaxRiskPctWithMinLot:riskPct),1)+"%. Naikkan modal, pilih SL lebih sempit, atau ganti simbol");
      return;
   }
   double actualPct=RiskPctOf(symbol,type,price,sl,volume);
   string riskNote=(slMode ? " | MODE BIAYA-SL: kerugian jika SL kena "+DoubleToString(actualPct,1)+"% ekuitas (lot minimum)" : actualPct>riskPct*1.001 ? " | PERHATIAN: lot minimum dipakai, risiko aktual "+DoubleToString(actualPct,2)+"% (diminta "+DoubleToString(riskPct,2)+"%)" : " | risiko aktual "+DoubleToString(actualPct,2)+"%");
   if(DryRun){ Ack(id,"DRYRUN","",(marketMode ? "[MARKET] " : "")+"Validasi lolos, order TIDAK dikirim (DryRun=true). Volume "+DoubleToString(volume,VolumeDigits(SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP)))+", entry "+DoubleToString(entry,digits)+riskNote); return; }
   int expSec=(planMode ? PlanExpirySeconds : PendingExpirySeconds);
   trade.SetExpertMagicNumber(MagicNumber); trade.SetDeviationInPoints(DeviationPoints); trade.SetTypeFillingBySymbol(symbol);
   string gv="AIEX_CMD_"+id;
   if(GlobalVariableCheck(gv)){ Ack(id,"DUPLICATE","","Perintah sudah diproses sebelumnya"); return; }
   GlobalVariableSet(gv,(double)TimeCurrent()); // idempotency guard: do not resend if acknowledgement is lost
   bool ok;
   if(marketMode) ok=(side=="BUY" ? trade.Buy(volume,symbol,0.0,sl,tp,"AI Exness "+id) : trade.Sell(volume,symbol,0.0,sl,tp,"AI Exness "+id));
   else ok=(side=="BUY" ? trade.BuyLimit(volume,entry,symbol,sl,tp,ORDER_TIME_SPECIFIED,TimeCurrent()+expSec,"AI Exness "+id) : trade.SellLimit(volume,entry,symbol,sl,tp,ORDER_TIME_SPECIFIED,TimeCurrent()+expSec,"AI Exness "+id));
   if(ok){ string tk=(string)trade.ResultOrder(); Ack(id,"EXECUTED",tk,(marketMode ? "Order MARKET terisi; volume " : "Pending limit diterima broker; volume ")+DoubleToString(volume,VolumeDigits(SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP)))+riskNote); Print("Executed ",side," ",symbol," volume ",volume," ticket ",tk); }
   else { Ack(id,"FAILED","",trade.ResultRetcodeDescription()); Print("Order failed: ",trade.ResultRetcodeDescription()); }
}

string SpecOf(const string sym,const double cap)
{
   double vmin=SymbolInfoDouble(sym,SYMBOL_VOLUME_MIN), vstep=SymbolInfoDouble(sym,SYMBOL_VOLUME_STEP);
   double tv=SymbolInfoDouble(sym,SYMBOL_TRADE_TICK_VALUE_LOSS), ts=SymbolInfoDouble(sym,SYMBOL_TRADE_TICK_SIZE);
   if(tv<=0) tv=SymbolInfoDouble(sym,SYMBOL_TRADE_TICK_VALUE);
   if(vmin<=0 || vstep<=0 || ts<=0 || tv<=0) return "";
   MqlTick t; double spr=0; if(SymbolInfoTick(sym,t) && t.ask>=t.bid) spr=t.ask-t.bid;
   // pu = kerugian dalam mata uang akun per 1.0 unit harga per 1 lot
   return "{\"s\":\""+sym+"\",\"vmin\":"+DoubleToString(vmin,4)+",\"vstep\":"+DoubleToString(vstep,4)+",\"pu\":"+DoubleToString(tv/ts,8)+",\"spr\":"+DoubleToString(spr,8)+",\"cap\":"+DoubleToString(cap,2)+"}";
}

// Spesifikasi dilaporkan untuk: (1) simbol di input SpecSymbols, lalu (2) SEMUA simbol yang tampil di Market Watch (maks 40), tanpa duplikat.
string BuildSpecs()
{
   string out="", seen="|"; double cap=(AllowMinLotOverBudget ? MaxRiskPctWithMinLot : 0.0);
   string parts[]; int n=StringSplit(SpecSymbols,',',parts);
   for(int i=0;i<n;i++)
   {
      string sym=Trim(parts[i]); if(sym=="" || StringFind(seen,"|"+sym+"|")>=0) continue;
      seen+=sym+"|"; if(!SymbolSelect(sym,true)) continue;
      string j=SpecOf(sym,cap); if(j=="") continue;
      if(out!="") out+=","; out+=j;
   }
   int tot=SymbolsTotal(true), cnt=0;
   for(int k=0;k<tot && cnt<40;k++)
   {
      string sym=SymbolName(k,true); if(sym=="" || StringFind(seen,"|"+sym+"|")>=0) continue;
      seen+=sym+"|";
      string j=SpecOf(sym,cap); if(j=="") continue;
      if(out!="") out+=","; out+=j; cnt++;
   }
   return "["+out+"]";
}

string BuildOrders()
{
   string out="";
   for(int j=0;j<OrdersTotal();j++)
   {
      ulong t=OrderGetTicket(j); if(t==0 || OrderGetInteger(ORDER_MAGIC)!=MagicNumber) continue;
      long ty=OrderGetInteger(ORDER_TYPE); string sd=(ty==ORDER_TYPE_BUY_LIMIT||ty==ORDER_TYPE_BUY_STOP||ty==ORDER_TYPE_BUY)?"BUY":"SELL";
      if(out!="") out+=",";
      out+="{\"s\":\""+OrderGetString(ORDER_SYMBOL)+"\",\"tk\":\""+(string)t+"\",\"side\":\""+sd+"\",\"px\":"+DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN),8)+",\"sl\":"+DoubleToString(OrderGetDouble(ORDER_SL),8)+",\"tp\":"+DoubleToString(OrderGetDouble(ORDER_TP),8)+"}";
   }
   return "["+out+"]";
}
string BuildPositions()
{
   string out="";
   for(int i=0;i<PositionsTotal();i++)
   {
      ulong t=PositionGetTicket(i); if(t==0 || PositionGetInteger(POSITION_MAGIC)!=MagicNumber) continue;
      string sd=(PositionGetInteger(POSITION_TYPE)==POSITION_TYPE_BUY)?"BUY":"SELL";
      if(out!="") out+=",";
      out+="{\"s\":\""+PositionGetString(POSITION_SYMBOL)+"\",\"tk\":\""+(string)t+"\",\"side\":\""+sd+"\",\"px\":"+DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN),8)+",\"sl\":"+DoubleToString(PositionGetDouble(POSITION_SL),8)+",\"tp\":"+DoubleToString(PositionGetDouble(POSITION_TP),8)+",\"pr\":"+DoubleToString(PositionGetDouble(POSITION_PROFIT),2)+"}";
   }
   return "["+out+"]";
}

void SendReport()
{
   if(!ReportAccount || GetTickCount64()-g_last_report<15000) return;
   g_last_report=GetTickCount64();
   string mode="UNKNOWN"; long m=AccountInfoInteger(ACCOUNT_TRADE_MODE);
   if(m==ACCOUNT_TRADE_MODE_DEMO) mode="DEMO"; else if(m==ACCOUNT_TRADE_MODE_CONTEST) mode="CONTEST"; else if(m==ACCOUNT_TRADE_MODE_REAL) mode="REAL";
   string account=(string)AccountInfoInteger(ACCOUNT_LOGIN), server=AccountInfoString(ACCOUNT_SERVER), currency=AccountInfoString(ACCOUNT_CURRENCY);
   string body="{\"action\":\"report\",\"account\":\""+account+"\",\"server\":\""+server+"\",\"currency\":\""+currency+"\",\"balance\":"+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2)+",\"equity\":"+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2)+",\"margin\":"+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN),2)+",\"tradeMode\":\""+mode+"\",\"connected\":"+(TerminalInfoInteger(TERMINAL_CONNECTED)?"true":"false")+",\"active\":"+(string)TotalActive()+",\"positions\":"+BuildPositions()+",\"orders\":"+BuildOrders()+",\"specs\":"+BuildSpecs()+"}";
   string out; Http("POST",ServerBaseUrl+"/mt5-command",body,out);
}

void OnTimer()
{
   string out;
   if(Http("GET",ServerBaseUrl+"/mt5-command","",out))
   {
      out=Trim(out);
      if(out!="" && out!="NONE") ProcessCommand(out);
   }
   SendReport();
}

int OnInit()
{
   if(StringFind(ServerBaseUrl,"https://")!=0 || StringFind(EaKey,"GANTI_")==0){ Print("Isi ServerBaseUrl dan EaKey terlebih dahulu."); return INIT_PARAMETERS_INCORRECT; }
   EventSetTimer(MathMax(2,PollSeconds));
   DayStartEquity();
   Print("AI Exness Bot aktif dalam mode ",(EnableExecution?(DryRun?"EXECUTION-DRYRUN (validasi saja, tanpa order)":"EXECUTION LIVE"):"READ/POLL ONLY"),". Akun live ",(AllowLiveAccount?"diizinkan oleh input EA":"DIBLOKIR"),".");
   SendReport();
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason){ EventKillTimer(); }
