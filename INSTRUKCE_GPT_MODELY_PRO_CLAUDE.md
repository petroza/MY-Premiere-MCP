# Výběr GPT modelu v panelu MY Premiere MCP

## Cíl

Když uživatel v poli **AI agent** vybere `Codex (GPT)`, pole **Model** musí nabídnout dostupné modely Codexu. Vybraný model se má použít při následujícím spuštění přes `codex exec -m <model>`.

Claude: implementuj tuto změnu přímo v `O:\MYpremiereMCP`. Zachovej současnou podporu modelů Claude a nezasahuj do střihových nástrojů.

## Co už je hotové

V `panel/main.js` už jsou důležité části připravené:

- `updateModelOptions()` skrývá volby podle atributu `data-agent`;
- větev Claude předává model přes `--model`;
- větev Codex předává model přes `-m`:

```js
if ($('model').value) args.push('-m', $('model').value);
```

V `panel/index.html` jsou ale momentálně pouze modely Claude. Proto se po přepnutí na `Codex (GPT)` ukazuje jen `výchozí model`.

## Doporučená implementace

### 1. Minimální a spolehlivá varianta

Do `<select id="model">` v `panel/index.html` přidej modely Codexu. Hodnota `value` musí být přesný slug pro parametr `-m`; atribut `data-agent="codex"` zajistí filtrování stávající funkcí `updateModelOptions()`.

```html
<select id="model" title="Model">
  <option value="">výchozí model</option>

  <option value="opus" data-agent="claude">Opus</option>
  <option value="sonnet" data-agent="claude">Sonnet</option>
  <option value="haiku" data-agent="claude">Haiku 4.5</option>

  <option value="gpt-6-astra" data-agent="codex">GPT-6 Astra</option>
  <option value="gpt-5.6-sol" data-agent="codex">GPT-5.6 Sol</option>
  <option value="gpt-5.6-terra" data-agent="codex">GPT-5.6 Terra</option>
  <option value="gpt-5.6-luna" data-agent="codex">GPT-5.6 Luna</option>
  <option value="gpt-5.5" data-agent="codex">GPT-5.5</option>
  <option value="gpt-5.2" data-agent="codex">GPT-5.2</option>
</select>
```

Tento seznam odpovídá viditelným modelům v místním katalogu Codex CLI dne 17. 9. 2026 (`codex debug models --bundled`). Volba `výchozí model` musí zůstat s prázdnou hodnotou; v takovém případě se parametr `-m` nepřidá a Codex použije svůj aktuální výchozí model.

### 2. Zapamatování volby pro každý agent

Při přepínání mezi Claude a Codexem si uchovej poslední model zvlášť. Bez toho může uživatel vybrat GPT model, přepnout na Claude a po návratu o volbu přijít.

Doporučené klíče:

```js
var selectedModelByAgent = {
  claude: localStorage.getItem('pmcp.model.claude') || '',
  codex: localStorage.getItem('pmcp.model.codex') || ''
};
```

Při změně `#model` ulož hodnotu pod klíčem aktivního agenta. Při změně `#agent` nejprve skryj cizí volby a potom obnov hodnotu daného agenta. Pokud uložený model už v seznamu není, nastav prázdnou hodnotu.

### 3. Robustnější varianta: načítání katalogu z Codex CLI

Statický seznam funguje hned, ale modely se časem mění. Lepší dlouhodobé řešení je při startu panelu asynchronně spustit:

```text
codex debug models --bundled
```

Příkaz vrací JSON s polem `models`. Použij pouze položky, kde `visibility === "list"`, a vytvoř z nich `<option data-agent="codex">`:

- `slug` použij jako `value`;
- `display_name` použij jako text;
- zachovej pořadí vrácené katalogem;
- při chybě příkazu ponech statický seznam výše;
- používej `cp.execFile`, ne shellový příkaz;
- použij existující `findExe('codex')`, protože Premiere často nemá aktuální `PATH`;
- nespouštěj synchronní `execSync` při načtení panelu, aby se UI nezablokovalo;
- stdout parsuj jako JSON; diagnostiku ze stderr nevkládej do selectu.

`--bundled` je zde záměrně: funguje bez sítě a odpovídá katalogu dodanému s právě nainstalovaným Codex CLI. Seznam může obsahovat model, ke kterému účet nemá přístup; případnou chybu při spuštění zobraz v panelu beze změny vybrané hodnoty.

## Volitelné: úroveň přemýšlení

Pokud chceš změnu dokončit i pro reasoning, přidej vedle modelu další select viditelný pouze pro Codex:

```html
<select id="reasoning" title="Úroveň přemýšlení">
  <option value="">výchozí úroveň</option>
  <option value="low">low</option>
  <option value="medium">medium</option>
  <option value="high">high</option>
  <option value="xhigh">xhigh</option>
  <option value="max">max</option>
  <option value="ultra">ultra</option>
</select>
```

Do argumentů Codexu přidej při neprázdné hodnotě:

```js
args.push('-c', 'model_reasoning_effort="' + $('reasoning').value + '"');
```

Ideálně nabídku omez podle `supported_reasoning_levels` vybraného modelu z katalogu. Aktuální místní katalog například podporuje `ultra` u `gpt-6-astra` a `gpt-5.6-sol`, ale ne u všech modelů.

## Bezpečnostní oprava, kterou zachovej odděleně

Současný `panel/main.js` používá `--dangerously-bypass-approvals-and-sandbox`. Tento přepínač není potřeba pro výběr modelu a nemá zůstat jako trvalé řešení. Nahraď ho omezeným nastavením:

```js
'--sandbox', 'read-only',
'-c', 'mcp_servers.premiere.default_tools_approval_mode="approve"',
'-c', 'mcp_servers.premiere.enabled_tools=["premiere_status","get_project","list_project_items","get_sequence","transcribe_media","get_transcript","search_transcript","build_sequence_from_transcript"]',
```

Pokud některý další Premiere nástroj později opravdu potřebuješ, přidej konkrétně jeho jméno do allowlistu. Nepovoluj tímto způsobem obecný shell ani všechny nástroje serveru.

## Ověření

1. Otevři panel a vyber `Claude Code`: zobrazí se jen výchozí volba a modely Claude.
2. Vyber `Codex (GPT)`: zobrazí se jen výchozí volba a GPT modely.
3. Vyber například `GPT-5.6 Luna`, spusť neškodný prompt a ověř v příkazové řádce procesu, že obsahuje `-m gpt-5.6-luna`.
4. Přepni zpět na Claude a potom na Codex; poslední volba každého agenta se obnoví.
5. Nech hodnotu `výchozí model`; ověř, že se `-m` do argumentů nepřidá.
6. Spusť `node --check panel/main.js`.
7. Ověř, že původní modely Claude a běh přes Premiere MCP stále fungují.

## Kritéria hotového výsledku

- modely obou agentů se navzájem nemíchají;
- volba GPT modelu se skutečně předá Codex CLI přes `-m`;
- prázdná volba respektuje výchozí model Codexu;
- neznámý nebo už nedostupný model vyvolá čitelnou chybu v panelu;
- panel se při zjišťování katalogu nezasekne;
- výběr modelu neoslabí sandbox ani oprávnění Premiere nástrojů.

## Oficiální zdroje

- Codex CLI podporuje volbu modelu a reasoning úrovně: <https://learn.chatgpt.com/docs/codex/cli>
- Konfigurační klíč `model` je řetězec a `model_reasoning_effort` podporuje hodnoty podle modelu: <https://learn.chatgpt.com/docs/config-file/config-reference>
- Aktuální přehled modelů OpenAI: <https://developers.openai.com/api/docs/models>

