Nhiet do (Temperature) - nguon du lieu

DataLive HTTP API KHONG tu do nhiet do.
No chi DOC file latest.json do PiNodeMonitorLive ghi ra.

Chuoi dung:
  OpenHardwareMonitorLib.dll
       -> PiNodeMonitorLive (Windows PRO)
       -> Data/PiNodeMonitorLive/latest.json  (field temp)
       -> DataLive /v1/status
       -> SoloHost Controller

Cach co nhiet do:
1. Chay MonitorLive Service (Windows PRO) — can file OpenHardwareMonitorLib.dll
   dat tai Data/assets/OpenHardwareMonitorLib.dll (kem theo package PRO).
2. Chay DataLive (Start-DataLive.bat / Run-DataLive.bat).
3. SoloHost se nhan temp trong /v1/status.

Khong can Admin chi de doc DataLive; OHM thuong can quyen doc sensor.
