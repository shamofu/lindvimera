# エンジンの削除と単独構成の検証

エンジンの実装は`src/engines/embedded`と`src/engines/builtin`、登録は`src/engines/registry.ts`に集約します。共有コードはレジストリの解析関数と遅延ローダー、`EngineBackend`と実行時facadeを使います。片方の具体型やVimオブジェクトをもう片方へ渡しません。

同梱エンジンには、既存の`src/runtime`、`src/ex`、Markdown・表・折り畳み・ナビゲーションの実行部分も属します。純粋な日本語境界・Markdown解析・表座標・折り畳み範囲は両方が利用します。完全な削除対象は`scripts/engines/ownership.mjs`に記載し、ソース・テスト・上流ソース・patch・型生成設定・専用検証スクリプトを同時に管理します。`installWordProvider`は同梱エンジン側の`word.ts`に置き、共有の日本語境界へadapter状態を混ぜません。

## 一方を削除する

1. 所有リストに従い、対象エンジンのソース・テスト・ビルド用ファイルを削除します。同梱エンジンを削除する場合はサブモジュール、`.generated`、patch、vendorの型設定と準備スクリプトも除きます。専用開発依存の`@codemirror/search`をmanifestとlockfileから除き、新規インストールで実体が残らないことを確認します。
2. 中央レジストリから対象の解析関数importとdescriptorを削除し、生存するエンジンを既定値にします。相手側のエンジン実装は変更しません。
3. 同梱エンジンを除く場合は`tsconfig.json`の上流Vim用`paths`を除きます。build・Vitestのaliasとvendor準備・型生成は、実装ディレクトリの有無に従います。削除したソースをstubや空クラスで補いません。
4. 歴史的な保存IDは`selection.ts`へ残します。保存された削除済みIDは生存する既定エンジンへ一度移行し、割り当ては消しません。設定・notice・reloadの動作も検証します。
5. 共有テスト、生存エンジンのテスト、型検査、製品・harnessビルドと実際のWindows E2Eを行います。ビルドはmetafileから削除エンジンや非同梱の上流Vimが混入していないことを検査します。

## 使い捨ての単独構成

```powershell
pnpm test:engines
pnpm verify:engines
pnpm verify:engines --install
pnpm verify:engines --install --engine=embedded
```

最初のコマンドは削除ツール自体のテストです。`verify:engines`は`.test-runtime/engine-removal/<engine>-<timestamp>/`へ新しい作業用コピーを作り、相手の実装・テスト・専用ビルドファイル・専用依存を物理的に省きます。元のチェックアウトは削除しません。書き換える製品ソースは中央レジストリだけです。専用依存の削除ではpnpmのmanager用lock文書を維持し、アプリ用文書の対応箇所だけを除きます。生存パッケージから参照されていれば検証を失敗させます。

通常の検証はインストール済みの依存ツリーをコピーし、リンクの参照先もコピー内へ移します。元の`node_modules`へのjunctionで代用しません。`--install`ではそのコピーを使わず、fixtureで`pnpm install --frozen-lockfile`を実行します。前者は依存のコピーを用いた実行確認、後者は新規インストールの確認として結果を区別してください。Linderaの検証済みキャッシュは再利用します。同梱エンジンのfixtureは固定リビジョンの上流Git objectを読み、fixture内に専用の生成先を作ります。

`--engine=embedded`または`--engine=builtin`で片方だけを検証できます。各fixtureで順番に型検査、共有・生存エンジンの単体テストとNodeスクリプトテスト、製品ビルド、harnessビルドを実行します。`engine-removal.json`に省略対象と依存の取得方法・ソース全体のSHA-256、`source-hashes.json`にソース各ファイルのSHA-256、`verification.json`と各`*.log`に実行結果、`.test-runtime/build/production-metafile.json`に実際のバンドル入力を保存します。ネイティブE2Eは自動で合格扱いにせず、各fixtureの配布物を独立Vaultへ入れて別途実行します。内蔵だけのharnessはネイティブコアのidentityを検査し、同梱のVim実装を含めません。

ディレクトリを置いたままflagだけを切り替える検査、相手のテストをskipしただけの検査、ビルドだけの検査は、この削除確認の代わりにはなりません。
