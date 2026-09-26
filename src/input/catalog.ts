import type { LindvimeraSettings, VimMode } from "../settings";
import { SUPPORTED_COMMANDS, SUPPORTED_EXTENSIONS, type SupportedCommand } from "./commands";
import { analyseKeyBindings } from "./policy";

export interface CommandGuideEntry {
  keys: string;
  label: string;
  category: string;
  description: string;
  example: string;
  modes: readonly VimMode[];
  enabled: boolean;
  reason?: string;
}

// Descriptions are shared by the searchable guide and the read-only pending UI.
const groups: readonly [string, string, string, string, string][] = [
  [
    "h j k l <Left> <Down> <Up> <Right>",
    "移動",
    "文字・行の移動",
    "h/左、j/下、k/上、l/右へ移動します。",
    "3j",
  ],
  [
    "w b e ge W B E gE",
    "移動",
    "単語の移動",
    "小文字は単語、大文字は空白区切りのWORDを移動します。",
    "2w",
  ],
  [
    "0 ^ $ <Home> <End>",
    "移動",
    "行頭・行末へ移動",
    "0は行頭、^は最初の非空白文字、$は行末です。",
    "d$",
  ],
  ["+ - _ <CR>", "移動", "行の先頭へ移動", "指定行の最初の非空白文字へ移動します。", "2+"],
  [
    "gg G",
    "移動",
    "文書・指定行へ移動",
    "ggは先頭、Gは末尾。カウントで行番号を指定します。",
    "12G",
  ],
  ["{ } ( )", "移動", "段落・文の移動", "波括弧は段落、丸括弧は文の境界へ移動します。", ")"],
  [
    "f<character> F<character> t<character> T<character> ; ,",
    "移動",
    "行内の文字を探す",
    "f/Fは指定文字、t/Tはその手前まで移動。;/,で繰り返します。",
    "f、",
  ],
  ["%", "移動", "対応する括弧へ移動", "現在位置に対応する括弧へ移動します。", "%"],
  ["gj gk g<Up> g<Down>", "画面", "表示行を移動", "折り返しを含む画面上の行を移動します。", "gj"],
  [
    "<C-f> <C-b> <C-d> <C-u> <PageUp> <PageDown>",
    "画面",
    "画面をスクロール",
    "前後の一画面または半画面へ移動します。",
    "<C-d>",
  ],
  ["H M L", "画面", "画面内の位置へ移動", "画面の上・中央・下の行へ移動します。", "M"],
  ["zz zt zb", "画面", "カーソル行の表示位置", "現在行を画面の中央・上・下へ配置します。", "zz"],
  [
    "d c y",
    "編集",
    "範囲を削除・変更・コピー",
    "続けて移動やテキストオブジェクトを指定します。同じキーを重ねると行操作です。",
    "ciw",
  ],
  ["> < =", "編集", "インデント", "範囲を右・左へ字下げ、または自動調整します。", ">>"],
  ["gu gU g~", "編集", "大小文字の変換", "範囲を小文字・大文字・大小反転へ変換します。", "gUiw"],
  [
    "x X D Y <Del> <BS>",
    "編集",
    "文字・行の操作",
    "x/Xは文字削除、Dは行末まで削除、Yは行コピー。Backspaceは左へ移動します。",
    "3x",
  ],
  ["p P", "編集", "貼り付け", "レジスタの内容を現在位置の後・前へ貼り付けます。", '"ap'],
  ["J gJ", "編集", "行の結合", "Jは区切り空白を調整し、gJは空白を追加せず結合します。", "3J"],
  ["~ r<character>", "編集", "文字の変更", "~は大小反転、rは次の文字で置き換えます。", "ra"],
  [
    "i I a A o O R C s S",
    "モード",
    "入力・置換を開始",
    "指定位置で挿入、行の追加、範囲の変更、またはReplaceを開始します。",
    "A",
  ],
  [
    "v V <C-v> gv",
    "選択",
    "Visual選択",
    "文字・行・矩形の選択、または直前のVisual選択を復元します。",
    "viw",
  ],
  [
    "u U <C-r>",
    "履歴・編集",
    "Undo・Redo・大小文字",
    "NormalのuはUndo、Ctrl-rはRedo。Visualのu/Uは小文字・大文字へ変換します。",
    "u",
  ],
  [
    "/ ? n N * # g* g# gn gN",
    "検索",
    "検索・一致の選択",
    "前後の検索、単語検索、繰り返し、一致範囲の選択を行います。",
    "cgn",
  ],
  [
    "q<register> @<register> .",
    "記録",
    "マクロ・編集の繰り返し",
    "qで記録、@で再生、.で直前の編集を繰り返します。",
    "qa…q → @a",
  ],
  [
    '"<register>',
    "記録",
    "レジスタの指定",
    "続くコピー・削除・貼り付けに使うレジスタを選びます。",
    '"ayiw',
  ],
  [
    "m<register> '<register> `<register> <C-o> <C-i>",
    "移動履歴",
    "マーク・ジャンプ履歴",
    "小文字マークを記録・復元し、Ctrl-o/iでノート内の履歴を移動します。",
    "ma → 'a",
  ],
  [
    ":",
    "Ex",
    "Exコマンド",
    "行範囲を指定した置換・削除・コピー・結合・並べ替えに対応します。",
    ":%s/old/new/g",
  ],
  [
    "<Esc> <C-[> <C-c>",
    "モード",
    "取消・モード解除",
    "未完の操作を取り消し、入力・選択を終了します。IMEや補完の取消を優先します。",
    "<Esc>",
  ],
  [
    "gf",
    "Markdown",
    "内部リンクを開く",
    "現在位置のwikiリンク・Markdown内部リンクを現在のペインで開きます。",
    "gf",
  ],
  [
    "[h ]h [l ]l",
    "Markdown",
    "見出し・リストへ移動",
    "前後の見出し、または同じインデントのリスト項目へ移動します。",
    "2]h",
  ],
  [
    "i* a* i_ a_ i` a` il al iC aC",
    "テキストオブジェクト",
    "Markdownの範囲",
    "強調・インラインコード・リンク・コードブロックの内側／全体を選びます。",
    "di*",
  ],
  [
    "ih ah",
    "テキストオブジェクト",
    "見出しの節",
    "ihは見出しを除く本文、ahは見出しと子節を含む全体。カウントは祖先階層です。本文専用です。",
    "2yah",
  ],
  [
    "iL aL",
    "テキストオブジェクト",
    "リスト項目と子項目",
    "iLは先頭マーカーを残した内容、aLは項目全体。カウントは親項目へ広げます。本文専用です。",
    "daL",
  ],
  [
    "ys ds cs gS",
    "Surround",
    "囲みの追加・削除・変更",
    "ysに範囲と囲み、ds/csに囲みを指定します。VisualのgSは選択を囲みます。",
    "ysiw)",
  ],
  [
    "<Tab> <S-Tab> [t ]t",
    "テーブル",
    "セル移動・表から移動",
    "NormalのTabで隣のセル、[t/]tで表の前後の本文へ移動します。",
    "<Tab>",
  ],
  [
    "zo zc za",
    "折り畳み",
    "一段の展開・折り畳み",
    "zoは開く、zcは閉じる、zaは切替。Normalのカウントは階層数です。本文専用です。",
    "2zo",
  ],
  [
    "zO zC zA",
    "折り畳み",
    "再帰的な開閉",
    "大文字は入れ子を再帰的に開閉します。zAの切替はNormal専用です。",
    "zO",
  ],
  [
    "zR zM",
    "折り畳み",
    "ノート全体の開閉",
    "現在のペインでzRは全展開、zMはすべて折り畳みます。",
    "zR",
  ],
];

export function commandDescription(
  keys: string,
  mode?: VimMode,
): {
  label: string;
  category: string;
  description: string;
  example: string;
} {
  if (mode === "visual" && (keys === "o" || keys === "O"))
    return {
      category: "選択",
      label: "選択の端点を切り替え",
      description:
        "Visual選択の操作する端を入れ替えます。Oは矩形選択の同じ行の反対側へ移動します。",
      example: keys,
    };
  if (mode === "visual" && (keys === "u" || keys === "U"))
    return {
      category: "編集",
      label: keys === "u" ? "選択を小文字へ変換" : "選択を大文字へ変換",
      description: "選択範囲の大小文字を変換してNormalへ戻ります。",
      example: `viw${keys}`,
    };
  if (mode === "normal" && keys === "u")
    return {
      category: "履歴",
      label: "Undo",
      description: "直前の編集を元に戻します。",
      example: "u",
    };
  const group = groups.find(([sequence]) => sequence.split(" ").includes(keys));
  if (group) {
    const [, category, label, description, example] = group;
    return { category, label, description, example };
  }
  return {
    category: "テキストオブジェクト",
    label: "単語・文・囲みの範囲",
    description: "iは内側、aは周囲を含む範囲を指定します。operatorまたはVisualから使います。",
    example: `y${keys}`,
  };
}

function guideCommands(): SupportedCommand[] {
  return [...SUPPORTED_COMMANDS, ...SUPPORTED_EXTENSIONS].flatMap((entry) => {
    if (!/^[ia]<register>$/.test(entry.keys)) return [entry];
    return [..."wWspbB()[]{}<>\"'`"].map((object) => ({ ...entry, keys: entry.keys[0] + object }));
  });
}

/** A complete shorter mapping consumes input before a longer command can match. */
function mappingShadows(from: string, keys: string): boolean {
  const prefix = from.match(/<[^>]+>|./gu) ?? [];
  const command = keys.match(/<[^>]+>|./gu) ?? [];
  return (
    prefix.length > 0 &&
    prefix.length <= command.length &&
    prefix.every((token, index) => token === command[index])
  );
}

export function getGuideEntries(settings: LindvimeraSettings): CommandGuideEntry[] {
  const analysis = analyseKeyBindings(settings.keyBindings, settings);
  const entries = guideCommands().flatMap((entry) =>
    entry.contexts.map((mode) => {
      const overridden = analysis.active.some(
        (binding) => binding.mode === mode && mappingShadows(binding.from, entry.keys),
      );
      const reason = !settings.enabled
        ? "Lindvimeraが無効です。"
        : entry.feature && !settings[entry.feature]
          ? "対応する機能が設定で無効です。"
          : overridden
            ? "ユーザー割り当てが優先されます。"
            : undefined;
      return {
        ...commandDescription(entry.keys, mode),
        keys: entry.keys,
        modes: [mode],
        enabled: !reason,
        reason,
      };
    }),
  );
  for (const binding of settings.keyBindings) {
    const shadowed = analysis.active.some(
      (other) =>
        other !== binding &&
        other.mode === binding.mode &&
        other.from !== binding.from &&
        mappingShadows(other.from, binding.from),
    );
    const reason =
      analysis.issues.find((issue) => issue.binding === binding)?.reason ??
      (!settings.enabled
        ? "Lindvimeraが無効です。"
        : shadowed
          ? "短いユーザー割り当てが優先されます。"
          : undefined);
    entries.push({
      keys: binding.from,
      label: "ユーザー割り当て",
      category: "ユーザー割り当て",
      description: `${binding.from} → ${binding.to}`,
      example: binding.to,
      modes: [binding.mode],
      enabled: !reason,
      reason,
    });
  }
  return entries;
}
