# gsd-utility-extension

Tek paket içinde iki özellik:

1. **Double-Esc stop**
   - Terminalde `Esc Esc` => `ctrl+alt+[` olarak yakalanır
   - `/gsd stop` komutunu gönderir

2. **OpenAI / OpenAI-Codex WHAM usage footer**
   - `openai` veya `openai-codex` model provider aktifken çalışır
   - Footer/context satırında:
     - `5h` (primary window)
     - `7d` (secondary window)
   - Veri kaynağı: `https://chatgpt.com/backend-api/wham/usage`

## Kurulum

```bash
cd /Users/emin/Desktop/project/gsd-utility-extension
./install.sh
```

Bu script eski split paketleri kaldırır:
- `gsd-openai-usage-bar`
- `gsd-double-esc-stop`

Sonra bu utility paketini local kurar.

Kurulum sonrası açık GSD oturumunda:

```bash
/reload
```

## Auth / Account çözümleme

Authorization sırası:
1. `CHATGPT_WHAM_AUTHORIZATION` / `CHATGPT_AUTHORIZATION` / `OPENAI_WHAM_AUTHORIZATION`
2. Yoksa aktif model için `modelRegistry.getApiKey(model)`

Account ID sırası:
1. `CHATGPT_ACCOUNT_ID` / `CHATGPT_WHAM_ACCOUNT_ID`
2. model headers/providerOptions
3. authorization JWT claim (`https://api.openai.com/auth.chatgpt_account_id`)
