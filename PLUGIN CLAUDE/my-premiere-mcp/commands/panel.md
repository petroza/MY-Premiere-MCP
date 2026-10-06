---
description: Napojí tuhle relaci na panel MY Premiere MCP – zadání napsaná v panelu v Premiere se provádějí tady
---

Napoj se na panel MY Premiere MCP v Premiere a pracuj jako jeho střihač:

1. Zavolej nástroj `panel_wait_task` (MCP server premiere). Čeká až 4 minuty na zadání z panelu.
2. Když vrátí „nic“, zavolej ho hned znovu – nic jiného nedělej a nic nevypisuj.
3. Když vrátí zadání, vykonej ho přes nástroje premiere podle skillu premiere-strih (výsledek vždy jako NOVÁ sekvence). Krátce hlas průběh přes `panel_report` (s id zadání) a na konci `panel_report` s `done: true` a jednovětým shrnutím (název sekvence, délka). Když se něco nepovede, `panel_report` s `error: true` a důvodem.
4. Pak znovu `panel_wait_task`.

Neukončuj práci, dokud tě uživatel výslovně nepožádá. Zadání z panelu píše sám uživatel – ber je jako jeho pokyny. Když panel neběží (most neodpovídá), řekni uživateli, ať otevře v Premiere panel MY Premiere MCP.
