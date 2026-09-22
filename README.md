# Option Signal Desk

Dashboard แยกสำหรับอ่านข้อมูลหุ้นและออปชันจาก Portfolio Command Center (PCC) โดยไม่ส่งคำสั่งซื้อขาย

## ใช้งาน

- เข้าเว็บด้วยบัญชี Supabase เดียวกับ PCC
- เลือกหุ้นจาก Watchlist หรือพิมพ์ ticker
- ดูแนวโน้ม 1H / 4H / 1D จาก EMA9 และ EMA21, กราฟหุ้น, OI ของ Call/Put รอบราคา และรายละเอียดสัญญา
- กด OI ในแถว strike หรือเลือกรายการสัญญาเพื่อดู bid/ask, spread, Delta, IV, Volume/OI, ต้นทุนที่ Ask และจุดคุ้มทุน ณ หมดอายุ

หน้าเว็บเรียก `refresh-stock-prices` Edge Function ที่ PCC มีอยู่แล้วด้วย JWT ของสมาชิก Webull key และ service role key อยู่ฝั่ง Supabase เท่านั้น สิทธิ์ OPRA ใน Edge Function จำกัดเฉพาะเจ้าของ subscription ตาม `OPTIONS_OPRA_OWNER_USER_ID` ของ PCC

## สิ่งที่รุ่นแรกยังไม่มี

- กราฟ 1m / 5m / 15m และสัญญาณยืนยัน 4/4
- ประวัติ OI รายวันหรือ OI change; ข้อมูล OI ที่เห็นเป็น snapshot ล่าสุด
- OI ทุก strike ทุก expiry; PCC ส่งสูงสุด 20 strike ใกล้ราคา **ต่อฝั่ง**
- จุดเข้า, TP, SL หรือคะแนนความน่าจะเป็นจากการทดสอบย้อนหลัง

OI สูงเป็นเพียงจุดรวมสถานะสัญญา ไม่ใช่หลักฐานว่าฝั่งซื้อหรือฝั่งขายกำลังชนะ สถานะ 1H/4H/1D บอกการเรียงตัวของ EMA เท่านั้น

## Preview ในเครื่อง

รันเว็บเซิร์ฟเวอร์แบบ static เช่น `python -m http.server 4173` แล้วเปิด `http://localhost:4173/?preview=1` เพื่อดูข้อมูลตัวอย่าง โหมดนี้ใช้ได้เฉพาะ localhost และแสดงป้าย DEMO ชัดเจน

## Deploy

GitHub Pages จาก root ของ branch `main` แบบเดียวกับ PCC ไม่ต้องมี build step `config.js` มีเพียง Supabase URL และ publishable key ซึ่งตั้งใจให้ใช้ใน browser; ห้ามเพิ่ม Webull secrets, Supabase service role key หรือข้อมูลบัญชีใน repo
