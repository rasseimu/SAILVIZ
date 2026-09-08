# 反省入力モバイルアプリ (Flutter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sailviz バックエンド（無改修）に接続し、部員が各自スマホから sailviz と同一フォーマットの反省・ロードマップを入力/編集でき、目標設定を AI が補佐する Flutter アプリ v1 を作る。

**Architecture:** 新規 Flutter プロジェクト（**別リポジトリ**）。レイヤは `pure logic（純関数）→ api_client（dio+cookie）→ repository → Riverpod provider → UI`。反省は「1人1日1個の軽量 `.sailviz.json`」として `PUT /api/projects/:name` で保存し、GPS を含む巨大ファイルには触れない。ロードマップは `PUT /api/overlays/roadmap` の自分キーのみ re-read マージ更新。AI は既存の汎用プロキシ `POST /api/ai-comment` にアプリ側で組んだプロンプトを流す。純ロジックは `flutter test` で TDD、リポジトリは fake api_client で契約テスト、UI は手動確認（sailviz の慣習に準拠）。

**Tech Stack:** Flutter (Dart 3), Riverpod, dio, cookie_jar (dio_cookie_manager), flutter_secure_storage, shared_preferences, `flutter_test`.

**Spec:** `docs/superpowers/specs/2026-09-08-reflection-mobile-app-design.md`（この plan と同じ sailviz repo 内。実装 repo からは spec のコピーを持ち込むか本 plan のスキーマ転記で自己完結できる）

## Global Constraints

- **バックエンドは無改修**（v1）。唯一の任意改修は Authorization ヘッダ対応1行（Task 21・使う場合のみ）。
- **プロジェクトファイル名規則**: `^[A-Za-z0-9._-]+\.sailviz\.json$`（日本語不可）。アプリは `sailviz-<YYYYMMDD-HHmm>-<slug>.sailviz.json`、slug は英数字（member id `m0`..`m19`）。
- **反省スキーマは sailviz と完全一致**（rig 12キー / notes 5キー / wind / practice / people[0]=自分フルネーム / id / createdAt）。空の rig 値は `null`（0 は保持）、未入力 notes は `""`。
- **軽量プロジェクト**に tracks/videos/marks/pins を含めない。`{version:1, savedAt, reflections:[refl], practiceDate}`。
- **AI 既定モデル** `gemini-3.6-flash`。AI 出力は必ずユーザー承認後に挿入。失敗はトースト表示し手入力継続。
- **認証**: 書込系（PUT / AIコメント）は `sailviz_token` Cookie 必須。unlock は `POST /api/unlock {password}`。
- **部員名簿（20名・fullName = "<family> <given>" 半角スペース区切り・id m0..m19）**:
  村瀬 礼 / 高田 咲 / 木下 佳穂 / 本間 由真 / 高原 直翔 / 小川 勇希 / 西本 亜美 / 風間 大煕 / 伊藤 理々子 / 佐藤 妙 / 大澤 希 / 押尾 明汰 / 上島 滉起 / 吉田 悠翔 / 宮田 櫂澄 / 引池 匠 / 緒方 菜那子 / 田巻 隆雅 / 原田 修有 / 星川 桃香
- **rig 12キー（順序）**: `boatNo,gear,prebend,rake,sideTension,foreTension,puller,peakRope,bridleHeight,jibLeader,jibPull,vangPull`
- **notes 5キー**: `goal,issue,discovery,slowFactor,fastFactor`
- **各純関数タスクの最後は必ず `flutter test <path>` PASS 確認 → commit**。

---

## File Structure（実装 repo）

```
lib/
  config.dart                    # baseUrl（--dart-define=SAILVIZ_BASE_URL）
  core/
    fields.dart                  # kRigFields, kNoteFields 定数
    normalize.dart               # toNum, normalizeRig, normalizeNotes
    member.dart                  # Member, kMembers(20), memberSlug
    reflection.dart              # Reflection/Rig/Notes/Wind/Practice + toJson/fromJson
    project_builder.dart         # buildReflectionProject, reflectionFileName
    prefill.dart                 # previousRig
    amedas.dart                  # amedasUrl, windDirName, parseWind, fetchWind
    roadmap.dart                 # Milestone, mergeMyRoadmapKey, roadmapProgress
    ai_prompts.dart              # AiPrompt + 4モードの build/parse
  data/
    api_client.dart              # ApiClient(dio+cookie): getJson/putJson/postJson/unlock/authStatus
    reflection_repository.dart   # listMySummaries, loadMyLatestRig, saveReflection
    roadmap_repository.dart      # loadRoadmap, saveMyEntry
    ai_repository.dart           # nextGoals/refineGoal/milestones/screenReferences
  reference/
    north_sails_guide.dart       # 風速帯×セッティングの静的テーブル + guideValuesFor
  state/                         # Riverpod providers（Task 13）
  ui/                            # screens/widgets（Task 14-19）
  main.dart
test/
  core/…                         # 各純関数の単体テスト
  data/…                         # fake ApiClient 契約テスト
  reference/…
```

---

## Task 0: プロジェクト雛形と依存

**Files:**
- Create: `pubspec.yaml`, `lib/config.dart`, `analysis_options.yaml`, `README.md`
- Create: `test/smoke_test.dart`

**Interfaces:**
- Produces: `String baseUrl` (config.dart) — 以降の api_client が参照。

- [ ] **Step 1: Flutter プロジェクト作成**

```bash
flutter create --org jp.sailviz --project-name sailviz_reflect .
```

- [ ] **Step 2: 依存追加**

```bash
flutter pub add flutter_riverpod dio dio_cookie_manager cookie_jar flutter_secure_storage shared_preferences
flutter pub add dev:flutter_test
```

- [ ] **Step 3: `lib/config.dart` を書く**

```dart
// ベースURLはビルド時に --dart-define=SAILVIZ_BASE_URL=... で注入。既定はローカル開発。
const String baseUrl = String.fromEnvironment(
  'SAILVIZ_BASE_URL',
  defaultValue: 'http://localhost:8000',
);
```

- [ ] **Step 4: スモークテスト**

```dart
// test/smoke_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/config.dart';

void main() {
  test('baseUrl has a default', () {
    expect(baseUrl.isNotEmpty, true);
  });
}
```

- [ ] **Step 5: 実行して PASS を確認**

Run: `flutter test test/smoke_test.dart`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold flutter project + deps + config"
```

---

## Task 1: フィールド定数と数値正規化

**Files:**
- Create: `lib/core/fields.dart`, `lib/core/normalize.dart`
- Test: `test/core/normalize_test.dart`

**Interfaces:**
- Produces:
  - `const List<String> kRigFields`（12・上の順序）, `const List<String> kNoteFields`（5）
  - `num? toNum(dynamic v)` — `''`/null/非数値→null、それ以外→num（0 保持）
  - `Map<String, num?> normalizeRig(Map? rig)` — 全12キー、未指定→null
  - `Map<String, String> normalizeNotes(Map? notes)` — 全5キー、未指定→`''`

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/core/normalize_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/core/fields.dart';
import 'package:sailviz_reflect/core/normalize.dart';

void main() {
  test('toNum: 空文字/null/非数値 → null、0は保持', () {
    expect(toNum(''), null);
    expect(toNum(null), null);
    expect(toNum('abc'), null);
    expect(toNum(0), 0);
    expect(toNum('3.5'), 3.5);
    expect(toNum(12), 12);
  });

  test('normalizeRig: 全12キーが揃い未指定はnull', () {
    final r = normalizeRig({'rake': '5', 'gear': 2, 'bogus': 9});
    expect(r.keys.toSet(), kRigFields.toSet());
    expect(r['rake'], 5);
    expect(r['gear'], 2);
    expect(r['prebend'], null);
    expect(r.containsKey('bogus'), false);
  });

  test('normalizeNotes: 全5キーが揃い未指定は空文字', () {
    final n = normalizeNotes({'goal': 'x'});
    expect(n.keys.toSet(), kNoteFields.toSet());
    expect(n['goal'], 'x');
    expect(n['issue'], '');
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/core/normalize_test.dart`
Expected: FAIL（未定義シンボル）

- [ ] **Step 3: 実装**

```dart
// lib/core/fields.dart
const List<String> kRigFields = [
  'boatNo', 'gear', 'prebend', 'rake', 'sideTension', 'foreTension',
  'puller', 'peakRope', 'bridleHeight', 'jibLeader', 'jibPull', 'vangPull',
];
const List<String> kNoteFields = ['goal', 'issue', 'discovery', 'slowFactor', 'fastFactor'];

const Map<String, String> kRigLabels = {
  'boatNo': '船番号', 'gear': 'ギア', 'prebend': 'プリベンド', 'rake': 'レーキ',
  'sideTension': 'サイドテンション', 'foreTension': 'フォアテンション', 'puller': 'プラー',
  'peakRope': 'ピークロープ', 'bridleHeight': 'ブライダル高', 'jibLeader': 'ジブリーダー',
  'jibPull': 'ジブ引き量', 'vangPull': 'バング引き量',
};
const Map<String, String> kNoteLabels = {
  'goal': '目標', 'issue': '感じている課題', 'discovery': '発見',
  'slowFactor': '遅かった要因', 'fastFactor': '速かった要因',
};
```

```dart
// lib/core/normalize.dart
import 'fields.dart';

num? toNum(dynamic v) {
  if (v == null || v == '') return null;
  if (v is num) return v;
  return num.tryParse(v.toString());
}

Map<String, num?> normalizeRig(Map? rig) {
  final out = <String, num?>{};
  for (final f in kRigFields) {
    out[f] = toNum(rig?[f]);
  }
  return out;
}

Map<String, String> normalizeNotes(Map? notes) {
  final out = <String, String>{};
  for (final f in kNoteFields) {
    out[f] = (notes?[f] ?? '').toString();
  }
  return out;
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/core/normalize_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/core/fields.dart lib/core/normalize.dart test/core/normalize_test.dart
git commit -m "feat: rig/notes fields + numeric normalization"
```

---

## Task 2: 部員名簿と slug

**Files:**
- Create: `lib/core/member.dart`
- Test: `test/core/member_test.dart`

**Interfaces:**
- Consumes: なし
- Produces:
  - `class Member { final String id; final String family; final String given; String get fullName => '$family $given'; }`
  - `const List<Member> kMembers`（20名・id は `m0`..`m19`）
  - `String memberSlug(Member m) => m.id`（ファイル名規則 `^[A-Za-z0-9._-]+$` 適合）

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/core/member_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/core/member.dart';

void main() {
  test('20名・id連番・fullNameは半角スペース区切り', () {
    expect(kMembers.length, 20);
    expect(kMembers.first.id, 'm0');
    expect(kMembers.first.fullName, '村瀬 礼');
    expect(kMembers.last.fullName, '星川 桃香');
  });

  test('memberSlug はファイル名規則に適合（英数字）', () {
    final re = RegExp(r'^[A-Za-z0-9._-]+$');
    for (final m in kMembers) {
      expect(re.hasMatch(memberSlug(m)), true, reason: m.fullName);
    }
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/core/member_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/core/member.dart
class Member {
  final String id;
  final String family;
  final String given;
  const Member(this.id, this.family, this.given);
  String get fullName => '$family $given';
}

const List<Member> kMembers = [
  Member('m0', '村瀬', '礼'), Member('m1', '高田', '咲'), Member('m2', '木下', '佳穂'),
  Member('m3', '本間', '由真'), Member('m4', '高原', '直翔'), Member('m5', '小川', '勇希'),
  Member('m6', '西本', '亜美'), Member('m7', '風間', '大煕'), Member('m8', '伊藤', '理々子'),
  Member('m9', '佐藤', '妙'), Member('m10', '大澤', '希'), Member('m11', '押尾', '明汰'),
  Member('m12', '上島', '滉起'), Member('m13', '吉田', '悠翔'), Member('m14', '宮田', '櫂澄'),
  Member('m15', '引池', '匠'), Member('m16', '緒方', '菜那子'), Member('m17', '田巻', '隆雅'),
  Member('m18', '原田', '修有'), Member('m19', '星川', '桃香'),
];

String memberSlug(Member m) => m.id;
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/core/member_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/core/member.dart test/core/member_test.dart
git commit -m "feat: member roster + filename-safe slug"
```

---

## Task 3: 反省モデル (Reflection) と JSON 往復

**Files:**
- Create: `lib/core/reflection.dart`
- Test: `test/core/reflection_test.dart`

**Interfaces:**
- Consumes: `normalizeRig`, `normalizeNotes` (Task 1)
- Produces:
  - `class Reflection`（フィールド: `id, createdAt, text, people, videos, wind, practice, rig, waveHeight, notes`）
  - `factory Reflection.build({...})` — people/rig/notes を正規化。`videos = []`。
  - `Map<String,dynamic> toJson()` / `factory Reflection.fromJson(Map json)`
  - 型: `wind` は `Map<String,dynamic>?`、`practice` は `Map<String,dynamic>?`

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/core/reflection_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/core/reflection.dart';
import 'package:sailviz_reflect/core/fields.dart';

void main() {
  test('build: 正規化して sailviz スキーマの JSON になる', () {
    final r = Reflection.build(
      id: 'refl1_m0', createdAt: 1000, text: '本文',
      people: ['村瀬 礼'],
      wind: {'dir': '南西', 'speed': 5, 'source': 'manual'},
      practice: {'date': '2026/08/28', 'startMs': 0, 'endMs': 0},
      rig: {'rake': '5'}, waveHeight: '1.2',
      notes: {'goal': '直進安定'},
    );
    final j = r.toJson();
    expect(j['id'], 'refl1_m0');
    expect(j['people'], ['村瀬 礼']);
    expect(j['videos'], []);
    expect((j['rig'] as Map).keys.toSet(), kRigFields.toSet());
    expect(j['rig']['rake'], 5);
    expect(j['rig']['gear'], null);
    expect((j['notes'] as Map)['goal'], '直進安定');
    expect((j['notes'] as Map)['issue'], '');
    expect(j['waveHeight'], 1.2);
  });

  test('fromJson→toJson は安定（round-trip）', () {
    final src = Reflection.build(
      id: 'refl2_m1', createdAt: 2000, text: 't', people: ['高田 咲'],
      rig: {'gear': 3}, notes: {'issue': 'ヘルム'},
    ).toJson();
    final back = Reflection.fromJson(src).toJson();
    expect(back, src);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/core/reflection_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/core/reflection.dart
import 'normalize.dart';

class Reflection {
  final String id;
  final int createdAt;
  final String text;
  final List<String> people;
  final List<Map<String, dynamic>> videos;
  final Map<String, dynamic>? wind;
  final Map<String, dynamic>? practice;
  final Map<String, num?> rig;
  final num? waveHeight;
  final Map<String, String> notes;

  const Reflection({
    required this.id,
    required this.createdAt,
    required this.text,
    required this.people,
    required this.videos,
    required this.wind,
    required this.practice,
    required this.rig,
    required this.waveHeight,
    required this.notes,
  });

  factory Reflection.build({
    required String id,
    required int createdAt,
    String text = '',
    List<String> people = const [],
    List<Map<String, dynamic>> videos = const [],
    Map<String, dynamic>? wind,
    Map<String, dynamic>? practice,
    Map? rig,
    dynamic waveHeight,
    Map? notes,
  }) {
    return Reflection(
      id: id,
      createdAt: createdAt,
      text: text,
      people: List<String>.from(people),
      videos: videos.map((v) => Map<String, dynamic>.from(v)).toList(),
      wind: wind == null ? null : Map<String, dynamic>.from(wind),
      practice: practice == null ? null : Map<String, dynamic>.from(practice),
      rig: normalizeRig(rig),
      waveHeight: toNum(waveHeight),
      notes: normalizeNotes(notes),
    );
  }

  Map<String, dynamic> toJson() => {
        'id': id,
        'createdAt': createdAt,
        'text': text,
        'people': people,
        'videos': videos,
        'wind': wind,
        'practice': practice,
        'rig': rig,
        'waveHeight': waveHeight,
        'notes': notes,
      };

  factory Reflection.fromJson(Map json) => Reflection.build(
        id: json['id'].toString(),
        createdAt: (json['createdAt'] as num).toInt(),
        text: (json['text'] ?? '').toString(),
        people: List<String>.from((json['people'] ?? const []).map((e) => e.toString())),
        videos: List<Map<String, dynamic>>.from(
            (json['videos'] ?? const []).map((e) => Map<String, dynamic>.from(e))),
        wind: json['wind'] == null ? null : Map<String, dynamic>.from(json['wind']),
        practice: json['practice'] == null ? null : Map<String, dynamic>.from(json['practice']),
        rig: json['rig'] is Map ? json['rig'] as Map : const {},
        waveHeight: json['waveHeight'],
        notes: json['notes'] is Map ? json['notes'] as Map : const {},
      );
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/core/reflection_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/core/reflection.dart test/core/reflection_test.dart
git commit -m "feat: Reflection model with sailviz-compatible JSON"
```

---

## Task 4: 軽量プロジェクト組立とファイル名

**Files:**
- Create: `lib/core/project_builder.dart`
- Test: `test/core/project_builder_test.dart`

**Interfaces:**
- Consumes: `Reflection` (Task 3)
- Produces:
  - `Map<String,dynamic> buildReflectionProject(Reflection refl, {required int practiceDate, required int savedAt})` → `{version:1, savedAt, reflections:[refl.toJson()], practiceDate}`
  - `String reflectionFileName(String slug, DateTime tsJst)` → `sailviz-YYYYMMDD-HHmm-<slug>.sailviz.json`（tsJst は JST 前提の DateTime）

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/core/project_builder_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/core/project_builder.dart';
import 'package:sailviz_reflect/core/reflection.dart';

void main() {
  final refl = Reflection.build(id: 'refl1_m0', createdAt: 1000, people: ['村瀬 礼']);

  test('buildReflectionProject は tracks 等を含めない軽量プロジェクト', () {
    final p = buildReflectionProject(refl, practiceDate: 5000, savedAt: 6000);
    expect(p['version'], 1);
    expect(p['savedAt'], 6000);
    expect(p['practiceDate'], 5000);
    expect((p['reflections'] as List).length, 1);
    expect(p.containsKey('tracks'), false);
    expect(p.containsKey('videos'), false);
  });

  test('reflectionFileName はファイル名規則に適合', () {
    final name = reflectionFileName('m0', DateTime(2026, 9, 8, 9, 5));
    expect(name, 'sailviz-20260908-0905-m0.sailviz.json');
    expect(RegExp(r'^[A-Za-z0-9._-]+\.sailviz\.json$').hasMatch(name), true);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/core/project_builder_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/core/project_builder.dart
import 'reflection.dart';

Map<String, dynamic> buildReflectionProject(
  Reflection refl, {
  required int practiceDate,
  required int savedAt,
}) {
  return {
    'version': 1,
    'savedAt': savedAt,
    'reflections': [refl.toJson()],
    'practiceDate': practiceDate,
  };
}

String _two(int n) => n.toString().padLeft(2, '0');

String reflectionFileName(String slug, DateTime tsJst) {
  final d = '${tsJst.year}${_two(tsJst.month)}${_two(tsJst.day)}';
  final t = '${_two(tsJst.hour)}${_two(tsJst.minute)}';
  return 'sailviz-$d-$t-$slug.sailviz.json';
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/core/project_builder_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/core/project_builder.dart test/core/project_builder_test.dart
git commit -m "feat: lightweight reflection project + filename builder"
```

---

## Task 5: 前回チューニングのプリフィル

**Files:**
- Create: `lib/core/prefill.dart`
- Test: `test/core/prefill_test.dart`

**Interfaces:**
- Consumes: `Reflection` (Task 3), `normalizeRig` (Task 1)
- Produces:
  - `Map<String,num?> previousRig(List<Reflection> myReflections)` — createdAt 昇順の最後の rig を返す。空なら全 null の rig。

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/core/prefill_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/core/prefill.dart';
import 'package:sailviz_reflect/core/reflection.dart';
import 'package:sailviz_reflect/core/fields.dart';

void main() {
  test('最新(createdAt最大)の rig を返す', () {
    final list = [
      Reflection.build(id: 'a', createdAt: 100, rig: {'rake': 4}),
      Reflection.build(id: 'b', createdAt: 300, rig: {'rake': 6}),
      Reflection.build(id: 'c', createdAt: 200, rig: {'rake': 5}),
    ];
    expect(previousRig(list)['rake'], 6);
  });

  test('空なら全キー null の rig', () {
    final r = previousRig([]);
    expect(r.keys.toSet(), kRigFields.toSet());
    expect(r.values.every((v) => v == null), true);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/core/prefill_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/core/prefill.dart
import 'reflection.dart';
import 'normalize.dart';

Map<String, num?> previousRig(List<Reflection> myReflections) {
  if (myReflections.isEmpty) return normalizeRig(null);
  final sorted = [...myReflections]..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  return normalizeRig(sorted.last.rig);
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/core/prefill_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/core/prefill.dart test/core/prefill_test.dart
git commit -m "feat: previousRig prefill"
```

---

## Task 6: アメダス（URL 組立・パース・取得）

**Files:**
- Create: `lib/core/amedas.dart`
- Test: `test/core/amedas_test.dart`

**Interfaces:**
- Consumes: なし
- Produces:
  - `String amedasUrl(int ms, {String point = '46141'})` — JST の yyyyMMdd と3時間ブロック開始HH。
  - `String windDirName(int idx)` — 0=静穏, 1..16 を22.5°刻み(16=北)。範囲外→'不明'。
  - `Map<String,dynamic>? parseWind(Map json, int targetMs)` — 最近傍で `wind[0]`/`windDirection[0]` が有効な要素 → `{speed,dirIdx,dirName,obsMs}`。無ければ null。
  - `Future<Map<String,dynamic>?> fetchWind(int targetMs, {Future<Map?> Function(String url) get})` — 取得成功で `{dir,dirIdx,speed,source:'amedas',station:'辻堂',obsMs}`、失敗/該当なしは null。

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/core/amedas_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/core/amedas.dart';

void main() {
  // 2026-08-28 12:40 JST = 2026-08-28T03:40:00Z
  final ms = DateTime.utc(2026, 8, 28, 3, 40).millisecondsSinceEpoch;

  test('amedasUrl: JST 日付＋3時間ブロック開始(12時→12)', () {
    expect(amedasUrl(ms),
        'https://www.jma.go.jp/bosai/amedas/data/point/46141/20260828_12.json');
  });

  test('windDirName: 16=北, 8=南, 0=静穏, 範囲外=不明', () {
    expect(windDirName(16), '北');
    expect(windDirName(8), '南');
    expect(windDirName(0), '静穏');
    expect(windDirName(99), '不明');
  });

  test('parseWind: targetMs に最も近い有効サンプルを選ぶ', () {
    final json = {
      '20260828124000': {'wind': [5.0, 0], 'windDirection': [10, 0]},
      '20260828130000': {'wind': [7.0, 0], 'windDirection': [12, 0]},
    };
    final w = parseWind(json, ms);
    expect(w!['speed'], 5.0);
    expect(w['dirIdx'], 10);
    expect(w['dirName'], '南西');
  });

  test('fetchWind: 成功で amedas 形の wind を返す', () async {
    Future<Map?> fakeGet(String url) async => {
          '20260828124000': {'wind': [5.0, 0], 'windDirection': [10, 0]},
        };
    final w = await fetchWind(ms, get: fakeGet);
    expect(w!['source'], 'amedas');
    expect(w['station'], '辻堂');
    expect(w['speed'], 5.0);
    expect(w['dir'], '南西');
  });

  test('fetchWind: 失敗(null)は null を返す', () async {
    Future<Map?> fakeGet(String url) async => null;
    expect(await fetchWind(ms, get: fakeGet), null);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/core/amedas_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/core/amedas.dart
const String amedasPoint = '46141';
const String amedasName = '辻堂';

const List<String> _dirNames = [
  '静穏', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西', '北',
];

String windDirName(int idx) =>
    (idx >= 0 && idx <= 16) ? _dirNames[idx] : '不明';

String _two(int n) => n.toString().padLeft(2, '0');

// epoch(ms) を JST(+9h) の壁時計に直す。
DateTime _jst(int ms) =>
    DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true).add(const Duration(hours: 9));

String amedasUrl(int ms, {String point = amedasPoint}) {
  final j = _jst(ms);
  final block = (j.hour ~/ 3) * 3;
  final ymd = '${j.year}${_two(j.month)}${_two(j.day)}';
  return 'https://www.jma.go.jp/bosai/amedas/data/point/$point/${ymd}_${_two(block)}.json';
}

// アメダスのキー 'yyyyMMddHHmmss'(JST) を epoch(ms) に。
int? _keyToMs(String key) {
  if (key.length < 14) return null;
  final iso = '${key.substring(0, 4)}-${key.substring(4, 6)}-${key.substring(6, 8)}'
      'T${key.substring(8, 10)}:${key.substring(10, 12)}:${key.substring(12, 14)}+09:00';
  return DateTime.tryParse(iso)?.millisecondsSinceEpoch;
}

Map<String, dynamic>? parseWind(Map json, int targetMs) {
  int? bestDiff;
  Map<String, dynamic>? best;
  json.forEach((key, entry) {
    final speed = (entry is Map) ? entry['wind']?[0] : null;
    final dirIdx = (entry is Map) ? entry['windDirection']?[0] : null;
    if (speed is! num || dirIdx is! num) return;
    final obsMs = _keyToMs(key.toString());
    if (obsMs == null) return;
    final diff = (obsMs - targetMs).abs();
    if (bestDiff == null || diff < bestDiff!) {
      bestDiff = diff;
      best = {
        'speed': speed,
        'dirIdx': dirIdx.toInt(),
        'dirName': windDirName(dirIdx.toInt()),
        'obsMs': obsMs,
      };
    }
  });
  return best;
}

Future<Map<String, dynamic>?> fetchWind(
  int targetMs, {
  required Future<Map?> Function(String url) get,
  String point = amedasPoint,
}) async {
  try {
    final json = await get(amedasUrl(targetMs, point: point));
    if (json == null) return null;
    final w = parseWind(json, targetMs);
    if (w == null) return null;
    return {
      'dir': w['dirName'],
      'dirIdx': w['dirIdx'],
      'speed': w['speed'],
      'source': 'amedas',
      'station': amedasName,
      'obsMs': w['obsMs'],
    };
  } catch (_) {
    return null;
  }
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/core/amedas_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/core/amedas.dart test/core/amedas_test.dart
git commit -m "feat: AMeDAS wind prefill (url/parse/fetch)"
```

---

## Task 7: ロードマップ（マージ・現在地）

**Files:**
- Create: `lib/core/roadmap.dart`
- Test: `test/core/roadmap_test.dart`

**Interfaces:**
- Consumes: なし
- Produces:
  - `Map<String,dynamic> mergeMyRoadmapKey(Map overlay, String name, Map entry)` — overlay をコピーし `name` キーだけ `entry` で置換（他キー不変）。
  - `({int total, int done, int currentIndex}) roadmapProgress(List milestones)` — 先頭からの最初の未達 index。全達成なら total。
  - `Map<String,dynamic> emptyRoadmapEntry()` → `{goal:'', milestones:[]}`

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/core/roadmap_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/core/roadmap.dart';

void main() {
  test('mergeMyRoadmapKey: 自分キーだけ更新し他は不変', () {
    final overlay = {
      '高田 咲': {'goal': 'keep', 'milestones': []},
    };
    final merged = mergeMyRoadmapKey(
        overlay, '村瀬 礼', {'goal': 'new', 'milestones': []});
    expect(merged['高田 咲'], {'goal': 'keep', 'milestones': []});
    expect(merged['村瀬 礼']['goal'], 'new');
    // 元 overlay は破壊しない
    expect(overlay.containsKey('村瀬 礼'), false);
  });

  test('roadmapProgress: 最初の未達が現在地、全達成は total', () {
    final r1 = roadmapProgress([
      {'done': true}, {'done': false}, {'done': true},
    ]);
    expect(r1.total, 3);
    expect(r1.done, 2);
    expect(r1.currentIndex, 1);

    final r2 = roadmapProgress([{'done': true}, {'done': true}]);
    expect(r2.currentIndex, 2);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/core/roadmap_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/core/roadmap.dart
Map<String, dynamic> emptyRoadmapEntry() => {'goal': '', 'milestones': []};

Map<String, dynamic> mergeMyRoadmapKey(Map overlay, String name, Map entry) {
  final out = <String, dynamic>{};
  overlay.forEach((k, v) => out[k.toString()] = v);
  out[name] = Map<String, dynamic>.from(entry);
  return out;
}

({int total, int done, int currentIndex}) roadmapProgress(List milestones) {
  final total = milestones.length;
  final done = milestones.where((m) => m is Map && m['done'] == true).length;
  var currentIndex = milestones.indexWhere((m) => !(m is Map && m['done'] == true));
  if (currentIndex == -1) currentIndex = total;
  return (total: total, done: done, currentIndex: currentIndex);
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/core/roadmap_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/core/roadmap.dart test/core/roadmap_test.dart
git commit -m "feat: roadmap merge + progress"
```

---

## Task 8: AI プロンプト生成とレスポンス検証（4モード）

**Files:**
- Create: `lib/core/ai_prompts.dart`
- Test: `test/core/ai_prompts_test.dart`

**Interfaces:**
- Consumes: なし
- Produces:
  - `class AiPrompt { final String system; final String user; }`
  - `AiPrompt buildNextGoalPrompt({required List<String> openIssues, required List<String> recentDiscoveries, required String roadmapGoal, required int currentIndex, required int total})`
  - `List<Map<String,String>> parseNextGoal(String text)` → `[{goal,why,measure}]`（不正要素は除外）
  - `AiPrompt buildRefineGoalPrompt(String draft)`
  - `Map<String,String>? parseRefineGoal(String text)` → `{refined,notes}`（refined 空なら null）
  - `AiPrompt buildMilestonePrompt(String bigGoal)`
  - `List<String> parseMilestones(String text)` → `[title,...]`
  - 内部: `dynamic extractJson(String text)` — コードフェンス無視で最初の `[`/`{` から対応する終端を取る。

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/core/ai_prompts_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/core/ai_prompts.dart';

void main() {
  test('buildNextGoalPrompt: 文脈が user に含まれ JSON 指示がある', () {
    final p = buildNextGoalPrompt(
      openIssues: ['ヘルムが強い'], recentDiscoveries: ['ヒール角5度が速い'],
      roadmapGoal: '関東インカレ入賞', currentIndex: 1, total: 4,
    );
    expect(p.system.contains('コーチ'), true);
    expect(p.user.contains('ヘルムが強い'), true);
    expect(p.user.contains('ヒール角5度が速い'), true);
    expect(p.user.contains('goal'), true);
  });

  test('parseNextGoal: コードフェンス付き JSON 配列を抽出・検証', () {
    const raw = '```json\n[{"goal":"g","why":"w","measure":"m"},{"goal":""}]\n```';
    final out = parseNextGoal(raw);
    expect(out.length, 1);
    expect(out.first['goal'], 'g');
    expect(out.first['measure'], 'm');
  });

  test('parseRefineGoal: refined 非空で {refined,notes}', () {
    const raw = '{"refined":"3セット直進を保つ","notes":"数値化"}';
    final out = parseRefineGoal(raw);
    expect(out!['refined'], '3セット直進を保つ');
    const empty = '{"refined":"","notes":"x"}';
    expect(parseRefineGoal(empty), null);
  });

  test('parseMilestones: title 配列を取り出す', () {
    const raw = '[{"title":"基礎"},{"title":"応用"},{"noise":1}]';
    expect(parseMilestones(raw), ['基礎', '応用']);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/core/ai_prompts_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/core/ai_prompts.dart
import 'dart:convert';

class AiPrompt {
  final String system;
  final String user;
  const AiPrompt(this.system, this.user);
}

// コードフェンス等を無視して最初の JSON（配列/オブジェクト）を取り出す。
dynamic extractJson(String text) {
  final t = text.replaceAll(RegExp(r'```(?:json)?', caseSensitive: false), '').trim();
  final starts = [t.indexOf('['), t.indexOf('{')].where((i) => i >= 0).toList()..sort();
  if (starts.isEmpty) throw const FormatException('no JSON');
  final start = starts.first;
  final open = t[start];
  final close = open == '[' ? ']' : '}';
  final end = t.lastIndexOf(close);
  if (end < start) throw const FormatException('no JSON end');
  return jsonDecode(t.substring(start, end + 1));
}

const _coach = 'あなたは経験豊富なセーリングコーチです。';

AiPrompt buildNextGoalPrompt({
  required List<String> openIssues,
  required List<String> recentDiscoveries,
  required String roadmapGoal,
  required int currentIndex,
  required int total,
}) {
  final system =
      '$_coach 未解決の課題・最近の発見・ロードマップの現在地から、次の練習で狙う具体的な目標を提案します。憶測で断定しないこと。';
  final user = [
    '# 未解決の課題',
    ...openIssues.map((e) => '- $e'),
    '',
    '# 最近の発見',
    ...recentDiscoveries.map((e) => '- $e'),
    '',
    '# ロードマップ',
    '大目標: $roadmapGoal（現在地 ${currentIndex + 1}/$total 段階）',
    '',
    '# 出力形式（JSON配列のみ・前後に説明文を付けない）',
    '[{"goal":"具体的な目標","why":"狙い1行","measure":"測定可能な達成条件"}]（最大3件）',
  ].join('\n');
  return AiPrompt(system, user);
}

List<Map<String, String>> parseNextGoal(String text) {
  final arr = extractJson(text);
  if (arr is! List) return [];
  final out = <Map<String, String>>[];
  for (final e in arr) {
    if (e is! Map) continue;
    final goal = (e['goal'] ?? '').toString().trim();
    if (goal.isEmpty) continue;
    out.add({
      'goal': goal,
      'why': (e['why'] ?? '').toString(),
      'measure': (e['measure'] ?? '').toString(),
    });
  }
  return out;
}

AiPrompt buildRefineGoalPrompt(String draft) {
  final system =
      '$_coach 曖昧な目標を、行動・数値・条件を含む測定可能な形へ整形します。意味は変えないこと。';
  final user = [
    '# 目標ドラフト',
    draft,
    '',
    '# 出力形式（JSONオブジェクトのみ）',
    '{"refined":"整形後の目標","notes":"変更点の要約"}',
  ].join('\n');
  return AiPrompt(system, user);
}

Map<String, String>? parseRefineGoal(String text) {
  final obj = extractJson(text);
  if (obj is! Map) return null;
  final refined = (obj['refined'] ?? '').toString().trim();
  if (refined.isEmpty) return null;
  return {'refined': refined, 'notes': (obj['notes'] ?? '').toString()};
}

AiPrompt buildMilestonePrompt(String bigGoal) {
  final system =
      '$_coach 大目標を達成順の中間マイルストーンに分解します。各1行・達成可否が判定できる粒度で。';
  final user = [
    '# 大目標',
    bigGoal,
    '',
    '# 出力形式（JSON配列のみ・4〜6個）',
    '[{"title":"マイルストーン"}]',
  ].join('\n');
  return AiPrompt(system, user);
}

List<String> parseMilestones(String text) {
  final arr = extractJson(text);
  if (arr is! List) return [];
  return arr
      .whereType<Map>()
      .map((e) => (e['title'] ?? '').toString().trim())
      .where((t) => t.isNotEmpty)
      .toList();
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/core/ai_prompts_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/core/ai_prompts.dart test/core/ai_prompts_test.dart
git commit -m "feat: AI goal-assist prompts + response parsers (4 modes)"
```

---

## Task 9: North Sails 参考ガイド静的テーブル

**Files:**
- Create: `lib/reference/north_sails_guide.dart`
- Test: `test/reference/north_sails_guide_test.dart`

**Interfaces:**
- Consumes: なし
- Produces:
  - `const List<String> kGuidePdfUrls`（2本）
  - `class GuideRow { final String windBand; final Map<String,String> values; }`（values のキーは rig フィールドのサブセット）
  - `const List<GuideRow> kNorthSailsGuide`
  - `Map<String,List<String>> guideValuesFor(String rigField)` → 風速帯→値（そのフィールドを持つ行だけ）

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/reference/north_sails_guide_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/reference/north_sails_guide.dart';

void main() {
  test('PDF URL が2本ある', () {
    expect(kGuidePdfUrls.length, 2);
    expect(kGuidePdfUrls.every((u) => u.startsWith('https://')), true);
  });

  test('guideValuesFor: 存在する rig フィールドは風速帯→値を返す', () {
    // rake は代表的にガイドに載る項目として同梱する前提
    final m = guideValuesFor('rake');
    expect(m.isNotEmpty, true);
  });

  test('guideValuesFor: ガイドに無いフィールドは空', () {
    expect(guideValuesFor('boatNo'), isEmpty);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/reference/north_sails_guide_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**（数値は North Sails 470 チューニングガイド PDF から手動抽出。**実装時に PDF を開いて実値へ要修正**。下記は構造の雛形＝プレースホルダ値ではなく、抽出した実値を入れること。抽出前でもテストが通るよう代表2項目 `rake`/`prebend` を最低限埋める。）

```dart
// lib/reference/north_sails_guide.dart
// North Sails 470 チューニングガイド（QTT）由来の参考値。
// 出典PDF: kGuidePdfUrls。数値は PDF から抽出して随時更新すること。
const List<String> kGuidePdfUrls = [
  'https://www.northsails.co.jp/wp/wp-content/uploads/2019/03/qtt_n9l5_j.pdf',
  'https://www.northsails.co.jp/wp/wp-content/uploads/2019/03/qtt_n12-l9b-_j.pdf',
];

class GuideRow {
  final String windBand;             // 例 '0-4kt', '5-9kt', '10kt+'
  final Map<String, String> values;  // rig フィールド → ガイド値（文字列で保持）
  const GuideRow(this.windBand, this.values);
}

// TODO(実装時): PDF から各風速帯の実値を抽出して values を埋める。
// 下は構造確認用に rake/prebend のみ最小限。実値へ差し替えること。
const List<GuideRow> kNorthSailsGuide = [
  GuideRow('0-4kt', {'rake': '要抽出', 'prebend': '要抽出'}),
  GuideRow('5-9kt', {'rake': '要抽出', 'prebend': '要抽出'}),
  GuideRow('10kt+', {'rake': '要抽出', 'prebend': '要抽出'}),
];

Map<String, List<String>> guideValuesFor(String rigField) {
  final out = <String, List<String>>{};
  for (final row in kNorthSailsGuide) {
    final v = row.values[rigField];
    if (v != null) (out[row.windBand] ??= []).add(v);
  }
  return out;
}
```

> 注: この Task の commit 後、別途「PDF から実値を抽出して `values` を更新」する後続作業を残す（§Plan末尾のフォローアップ参照）。構造とルックアップはこの Task で確定・テスト済みにする。

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/reference/north_sails_guide_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/reference/north_sails_guide.dart test/reference/north_sails_guide_test.dart
git commit -m "feat: North Sails guide table structure + lookup"
```

---

## Task 10: ApiClient（dio + cookie + unlock）

**Files:**
- Create: `lib/data/api_client.dart`
- Test: `test/data/api_client_test.dart`

**Interfaces:**
- Consumes: `baseUrl` (Task 0)
- Produces:
  - `abstract class HttpTransport { Future<HttpResp> send(String method, String path, {Object? body}); }`
  - `class HttpResp { final int status; final dynamic json; final Map<String,String> headers; }`
  - `class ApiClient { ApiClient(this._t); ... }`（`_t` は HttpTransport＝テストで fake 注入）
    - `Future<List> getJson(String path)` / `Future<Map> getJsonMap(String path)`
    - `Future<void> putJson(String path, Object body)`（非2xx は `ApiException`）
    - `Future<String> postAiComment(Map body)` → text
    - `Future<bool> unlock(String password)` / `Future<bool> authStatus()`
  - `class ApiException implements Exception { final int status; final String message; }`
  - 本番用 `class DioTransport implements HttpTransport`（dio+cookie_jar・secure_storage トークン Authorization フォールバック）は本 Task で作るが、テストは fake transport で行う。

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/data/api_client_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/data/api_client.dart';

class FakeTransport implements HttpTransport {
  final List<List<String>> calls = [];
  final Map<String, HttpResp> routes;
  FakeTransport(this.routes);
  @override
  Future<HttpResp> send(String method, String path, {Object? body}) async {
    calls.add([method, path]);
    return routes['$method $path'] ??
        HttpResp(404, {'error': 'no route'}, const {});
  }
}

void main() {
  test('unlock: password 一致で true', () async {
    final t = FakeTransport({'POST /api/unlock': HttpResp(200, {'unlocked': true}, const {})});
    final api = ApiClient(t);
    expect(await api.unlock('pw'), true);
  });

  test('putJson: 非2xx は ApiException(status)', () async {
    final t = FakeTransport({'PUT /api/projects/x.sailviz.json': HttpResp(401, {'error': 'unauthorized'}, const {})});
    final api = ApiClient(t);
    expect(
      () => api.putJson('/api/projects/x.sailviz.json', {'a': 1}),
      throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)),
    );
  });

  test('postAiComment: text を返す', () async {
    final t = FakeTransport({'POST /api/ai-comment': HttpResp(200, {'text': 'hello'}, const {})});
    final api = ApiClient(t);
    expect(await api.postAiComment({'system': 's'}), 'hello');
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/data/api_client_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/data/api_client.dart
class HttpResp {
  final int status;
  final dynamic json;
  final Map<String, String> headers;
  HttpResp(this.status, this.json, this.headers);
  bool get ok => status >= 200 && status < 300;
}

abstract class HttpTransport {
  Future<HttpResp> send(String method, String path, {Object? body});
}

class ApiException implements Exception {
  final int status;
  final String message;
  ApiException(this.status, this.message);
  @override
  String toString() => 'ApiException($status): $message';
}

class ApiClient {
  final HttpTransport _t;
  ApiClient(this._t);

  Future<List> getJson(String path) async {
    final r = await _t.send('GET', path);
    if (!r.ok) throw ApiException(r.status, _err(r));
    return r.json as List;
  }

  Future<Map> getJsonMap(String path) async {
    final r = await _t.send('GET', path);
    if (!r.ok) throw ApiException(r.status, _err(r));
    return r.json as Map;
  }

  Future<void> putJson(String path, Object body) async {
    final r = await _t.send('PUT', path, body: body);
    if (!r.ok) throw ApiException(r.status, _err(r));
  }

  Future<String> postAiComment(Map body) async {
    final r = await _t.send('POST', '/api/ai-comment', body: body);
    if (!r.ok) throw ApiException(r.status, _err(r));
    return (r.json as Map)['text'].toString();
  }

  Future<bool> unlock(String password) async {
    final r = await _t.send('POST', '/api/unlock', body: {'password': password});
    return r.ok && (r.json is Map) && r.json['unlocked'] == true;
  }

  Future<bool> authStatus() async {
    final r = await _t.send('GET', '/api/auth');
    return r.ok && (r.json is Map) && r.json['unlocked'] == true;
  }

  String _err(HttpResp r) =>
      (r.json is Map && r.json['error'] != null) ? r.json['error'].toString() : 'HTTP ${r.status}';
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/data/api_client_test.dart`
Expected: PASS

- [ ] **Step 5: DioTransport を追加（本番用・手動確認）**

```dart
// lib/data/dio_transport.dart
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:cookie_jar/cookie_jar.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../config.dart';
import 'api_client.dart';

class DioTransport implements HttpTransport {
  final Dio _dio;
  final FlutterSecureStorage _store;
  DioTransport({Dio? dio, FlutterSecureStorage? store})
      : _dio = dio ?? Dio(BaseOptions(baseUrl: baseUrl, validateStatus: (_) => true)),
        _store = store ?? const FlutterSecureStorage() {
    _dio.interceptors.add(CookieManager(CookieJar()));
  }

  @override
  Future<HttpResp> send(String method, String path, {Object? body}) async {
    // Cookie が落ちる環境向けに Authorization フォールバック（サーバ対応時のみ有効）。
    final token = await _store.read(key: 'sailviz_token');
    final res = await _dio.request(
      path,
      data: body,
      options: Options(
        method: method,
        headers: token == null ? null : {'Authorization': 'Bearer $token'},
        contentType: 'application/json',
      ),
    );
    return HttpResp(
      res.statusCode ?? 0,
      res.data,
      res.headers.map.map((k, v) => MapEntry(k, v.join(','))),
    );
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/data/api_client.dart lib/data/dio_transport.dart test/data/api_client_test.dart
git commit -m "feat: ApiClient (transport-injectable) + DioTransport"
```

---

## Task 11: ReflectionRepository（契約テスト）

**Files:**
- Create: `lib/data/reflection_repository.dart`
- Test: `test/data/reflection_repository_test.dart`

**Interfaces:**
- Consumes: `ApiClient` (Task 10), `Reflection` (Task 3), `buildReflectionProject`/`reflectionFileName` (Task 4), `previousRig` (Task 5)
- Produces:
  - `class ReflectionRepository { ReflectionRepository(this._api); ... }`
    - `Future<List<Reflection>> loadMyReflections(String fullName)` — `/api/projects` を列挙し各 project を読み、`people[0]==fullName` の反省を集める。
    - `Future<Map<String,num?>> loadMyPreviousRig(String fullName)` — 上を使い `previousRig`。
    - `Future<void> saveReflection({required Reflection refl, required String slug, required DateTime tsJst, required int practiceDate})` — `buildReflectionProject`→`PUT /api/projects/<reflectionFileName>`。

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/data/reflection_repository_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/data/api_client.dart';
import 'package:sailviz_reflect/data/reflection_repository.dart';
import 'package:sailviz_reflect/core/reflection.dart';

class FakeTransport implements HttpTransport {
  final Map<String, HttpResp> routes;
  final List<List<dynamic>> puts = [];
  FakeTransport(this.routes);
  @override
  Future<HttpResp> send(String method, String path, {Object? body}) async {
    if (method == 'PUT') puts.add([path, body]);
    return routes['$method $path'] ?? HttpResp(404, {'error': 'x'}, const {});
  }
}

void main() {
  test('loadMyPreviousRig: 自分の最新反省の rig を返す', () async {
    final t = FakeTransport({
      'GET /api/projects': HttpResp(200, [
        {'name': 'a.sailviz.json'},
        {'name': 'b.sailviz.json'},
      ], const {}),
      'GET /api/projects/a.sailviz.json': HttpResp(200, {
        'reflections': [
          {'id': 'r1', 'createdAt': 100, 'people': ['村瀬 礼'], 'rig': {'rake': 4}}
        ]
      }, const {}),
      'GET /api/projects/b.sailviz.json': HttpResp(200, {
        'reflections': [
          {'id': 'r2', 'createdAt': 300, 'people': ['村瀬 礼'], 'rig': {'rake': 6}},
          {'id': 'r3', 'createdAt': 400, 'people': ['高田 咲'], 'rig': {'rake': 9}},
        ]
      }, const {}),
    });
    final repo = ReflectionRepository(ApiClient(t));
    final rig = await repo.loadMyPreviousRig('村瀬 礼');
    expect(rig['rake'], 6); // 高田の 9 は無視
  });

  test('saveReflection: 正しいファイル名で PUT する', () async {
    final t = FakeTransport({
      'PUT /api/projects/sailviz-20260908-0905-m0.sailviz.json':
          HttpResp(200, {'ok': true}, const {}),
    });
    final repo = ReflectionRepository(ApiClient(t));
    await repo.saveReflection(
      refl: Reflection.build(id: 'r', createdAt: 1, people: ['村瀬 礼']),
      slug: 'm0', tsJst: DateTime(2026, 9, 8, 9, 5), practiceDate: 5000,
    );
    expect(t.puts.first[0], '/api/projects/sailviz-20260908-0905-m0.sailviz.json');
    expect((t.puts.first[1] as Map)['version'], 1);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/data/reflection_repository_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/data/reflection_repository.dart
import '../core/reflection.dart';
import '../core/prefill.dart';
import '../core/project_builder.dart';
import 'api_client.dart';

class ReflectionRepository {
  final ApiClient _api;
  ReflectionRepository(this._api);

  Future<List<Reflection>> loadMyReflections(String fullName) async {
    final list = await _api.getJson('/api/projects');
    final mine = <Reflection>[];
    for (final item in list) {
      final name = (item as Map)['name'].toString();
      try {
        final proj = await _api.getJsonMap('/api/projects/$name');
        final refls = (proj['reflections'] as List?) ?? const [];
        for (final r in refls) {
          final people = (r as Map)['people'];
          if (people is List && people.isNotEmpty && people.first == fullName) {
            mine.add(Reflection.fromJson(r));
          }
        }
      } catch (_) {/* 壊れたファイルは飛ばす */}
    }
    return mine;
  }

  Future<Map<String, num?>> loadMyPreviousRig(String fullName) async {
    return previousRig(await loadMyReflections(fullName));
  }

  Future<void> saveReflection({
    required Reflection refl,
    required String slug,
    required DateTime tsJst,
    required int practiceDate,
  }) async {
    final proj = buildReflectionProject(
      refl,
      practiceDate: practiceDate,
      savedAt: tsJst.millisecondsSinceEpoch,
    );
    final name = reflectionFileName(slug, tsJst);
    await _api.putJson('/api/projects/$name', proj);
  }
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/data/reflection_repository_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/data/reflection_repository.dart test/data/reflection_repository_test.dart
git commit -m "feat: ReflectionRepository (load mine / prev rig / save)"
```

---

## Task 12: RoadmapRepository（契約テスト）

**Files:**
- Create: `lib/data/roadmap_repository.dart`
- Test: `test/data/roadmap_repository_test.dart`

**Interfaces:**
- Consumes: `ApiClient` (Task 10), `mergeMyRoadmapKey`/`emptyRoadmapEntry` (Task 7)
- Produces:
  - `class RoadmapRepository { RoadmapRepository(this._api); ... }`
    - `Future<Map> loadRoadmap()` — `GET /api/overlays/roadmap`
    - `Future<Map> loadMyEntry(String fullName)` — 無ければ `emptyRoadmapEntry()`
    - `Future<void> saveMyEntry(String fullName, Map entry)` — **PUT 直前に re-read**→`mergeMyRoadmapKey`→`PUT`

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/data/roadmap_repository_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/data/api_client.dart';
import 'package:sailviz_reflect/data/roadmap_repository.dart';

class FakeTransport implements HttpTransport {
  Map current;
  Object? lastPut;
  FakeTransport(this.current);
  @override
  Future<HttpResp> send(String method, String path, {Object? body}) async {
    if (method == 'GET' && path == '/api/overlays/roadmap') {
      return HttpResp(200, current, const {});
    }
    if (method == 'PUT' && path == '/api/overlays/roadmap') {
      lastPut = body;
      current = body as Map;
      return HttpResp(200, {'ok': true}, const {});
    }
    return HttpResp(404, {'error': 'x'}, const {});
  }
}

void main() {
  test('saveMyEntry: re-read してから自分キーだけマージ PUT', () async {
    final t = FakeTransport({'高田 咲': {'goal': 'keep', 'milestones': []}});
    final repo = RoadmapRepository(ApiClient(t));
    await repo.saveMyEntry('村瀬 礼', {'goal': 'mine', 'milestones': []});
    final put = t.lastPut as Map;
    expect(put['高田 咲'], {'goal': 'keep', 'milestones': []}); // 他人不変
    expect(put['村瀬 礼']['goal'], 'mine');
  });

  test('loadMyEntry: 無ければ空エントリ', () async {
    final t = FakeTransport({});
    final repo = RoadmapRepository(ApiClient(t));
    final e = await repo.loadMyEntry('村瀬 礼');
    expect(e['goal'], '');
    expect(e['milestones'], []);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/data/roadmap_repository_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/data/roadmap_repository.dart
import '../core/roadmap.dart';
import 'api_client.dart';

class RoadmapRepository {
  final ApiClient _api;
  RoadmapRepository(this._api);

  Future<Map> loadRoadmap() async {
    try {
      return await _api.getJsonMap('/api/overlays/roadmap');
    } catch (_) {
      return {};
    }
  }

  Future<Map> loadMyEntry(String fullName) async {
    final all = await loadRoadmap();
    final e = all[fullName];
    if (e is Map) return {...emptyRoadmapEntry(), ...e};
    return emptyRoadmapEntry();
  }

  Future<void> saveMyEntry(String fullName, Map entry) async {
    final fresh = await loadRoadmap(); // PUT 直前に re-read
    final merged = mergeMyRoadmapKey(fresh, fullName, entry);
    await _api.putJson('/api/overlays/roadmap', merged);
  }
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/data/roadmap_repository_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/data/roadmap_repository.dart test/data/roadmap_repository_test.dart
git commit -m "feat: RoadmapRepository (re-read merge save)"
```

---

## Task 13: AiRepository（契約テスト）

**Files:**
- Create: `lib/data/ai_repository.dart`
- Test: `test/data/ai_repository_test.dart`

**Interfaces:**
- Consumes: `ApiClient` (Task 10), `ai_prompts.dart` (Task 8)
- Produces:
  - `class AiRepository { AiRepository(this._api, {this.model = 'gemini-3.6-flash'}); ... }`
    - `Future<List<Map<String,String>>> nextGoals({...})` — buildNextGoalPrompt→postAiComment→parseNextGoal
    - `Future<Map<String,String>?> refineGoal(String draft)`
    - `Future<List<String>> proposeMilestones(String bigGoal)`
  - AI 呼び出しは `postAiComment` に `{model, system, parts:[{text:user}], responseMimeType:'application/json'}` を渡す。

- [ ] **Step 1: 失敗するテストを書く**

```dart
// test/data/ai_repository_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/data/api_client.dart';
import 'package:sailviz_reflect/data/ai_repository.dart';

class FakeTransport implements HttpTransport {
  final String responseText;
  Map? lastBody;
  FakeTransport(this.responseText);
  @override
  Future<HttpResp> send(String method, String path, {Object? body}) async {
    lastBody = body as Map?;
    return HttpResp(200, {'text': responseText}, const {});
  }
}

void main() {
  test('nextGoals: プロンプトを送り JSON をパース', () async {
    final t = FakeTransport('[{"goal":"g","why":"w","measure":"m"}]');
    final repo = AiRepository(ApiClient(t));
    final out = await repo.nextGoals(
      openIssues: ['i'], recentDiscoveries: ['d'], roadmapGoal: 'G',
      currentIndex: 0, total: 3,
    );
    expect(out.first['goal'], 'g');
    expect((t.lastBody!['parts'] as List).isNotEmpty, true);
    expect(t.lastBody!['model'], 'gemini-3.6-flash');
  });

  test('refineGoal: {refined,notes}', () async {
    final t = FakeTransport('{"refined":"R","notes":"N"}');
    final repo = AiRepository(ApiClient(t));
    final out = await repo.refineGoal('draft');
    expect(out!['refined'], 'R');
  });

  test('proposeMilestones: title 配列', () async {
    final t = FakeTransport('[{"title":"a"},{"title":"b"}]');
    final repo = AiRepository(ApiClient(t));
    expect(await repo.proposeMilestones('big'), ['a', 'b']);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/data/ai_repository_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装**

```dart
// lib/data/ai_repository.dart
import '../core/ai_prompts.dart';
import 'api_client.dart';

class AiRepository {
  final ApiClient _api;
  final String model;
  AiRepository(this._api, {this.model = 'gemini-3.6-flash'});

  Future<String> _run(AiPrompt p) => _api.postAiComment({
        'model': model,
        'system': p.system,
        'parts': [
          {'text': p.user}
        ],
        'responseMimeType': 'application/json',
      });

  Future<List<Map<String, String>>> nextGoals({
    required List<String> openIssues,
    required List<String> recentDiscoveries,
    required String roadmapGoal,
    required int currentIndex,
    required int total,
  }) async {
    final text = await _run(buildNextGoalPrompt(
      openIssues: openIssues,
      recentDiscoveries: recentDiscoveries,
      roadmapGoal: roadmapGoal,
      currentIndex: currentIndex,
      total: total,
    ));
    return parseNextGoal(text);
  }

  Future<Map<String, String>?> refineGoal(String draft) async {
    return parseRefineGoal(await _run(buildRefineGoalPrompt(draft)));
  }

  Future<List<String>> proposeMilestones(String bigGoal) async {
    return parseMilestones(await _run(buildMilestonePrompt(bigGoal)));
  }
}
```

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/data/ai_repository_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/data/ai_repository.dart test/data/ai_repository_test.dart
git commit -m "feat: AiRepository (nextGoals/refineGoal/milestones via proxy)"
```

---

## Task 14: Riverpod providers と本人・認証状態

**Files:**
- Create: `lib/state/providers.dart`, `lib/state/session.dart`
- Test: `test/state/session_test.dart`

**Interfaces:**
- Consumes: すべてのリポジトリ・`kMembers`
- Produces:
  - `apiClientProvider`（DioTransport 注入）, `reflectionRepoProvider`, `roadmapRepoProvider`, `aiRepoProvider`
  - `class SessionState { final Member? me; final bool unlocked; }`
  - `class SessionNotifier extends StateNotifier<SessionState>`：`selectMember(Member)`（shared_prefs 永続）、`load()`（起動時復元）、`unlock(String pw)`（ApiClient.unlock→state 更新）
  - `sessionProvider`

- [ ] **Step 1: 失敗するテストを書く**（純ロジック部：選択の永続と復元を fake storage で）

```dart
// test/state/session_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/state/session.dart';
import 'package:sailviz_reflect/core/member.dart';

class MemStore implements SessionStore {
  final Map<String, String> m = {};
  @override
  Future<String?> read(String k) async => m[k];
  @override
  Future<void> write(String k, String v) async => m[k] = v;
}

void main() {
  test('selectMember を保存し load で復元', () async {
    final store = MemStore();
    final n1 = SessionNotifier(store: store, unlockFn: (_) async => true);
    await n1.selectMember(kMembers[2]);
    expect(n1.state.me!.id, 'm2');

    final n2 = SessionNotifier(store: store, unlockFn: (_) async => true);
    await n2.load();
    expect(n2.state.me!.id, 'm2');
  });

  test('unlock 成功で unlocked=true', () async {
    final n = SessionNotifier(store: MemStore(), unlockFn: (_) async => true);
    await n.unlock('pw');
    expect(n.state.unlocked, true);
  });
}
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `flutter test test/state/session_test.dart`
Expected: FAIL

- [ ] **Step 3: 実装（session.dart は StateNotifier を Flutter 非依存に：storage/unlock を注入）**

```dart
// lib/state/session.dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../core/member.dart';

abstract class SessionStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
}

class SessionState {
  final Member? me;
  final bool unlocked;
  const SessionState({this.me, this.unlocked = false});
  SessionState copyWith({Member? me, bool? unlocked}) =>
      SessionState(me: me ?? this.me, unlocked: unlocked ?? this.unlocked);
}

class SessionNotifier extends StateNotifier<SessionState> {
  final SessionStore store;
  final Future<bool> Function(String password) unlockFn;
  SessionNotifier({required this.store, required this.unlockFn})
      : super(const SessionState());

  static const _kMemberId = 'me_member_id';

  Future<void> load() async {
    final id = await store.read(_kMemberId);
    if (id == null) return;
    final m = kMembers.where((e) => e.id == id).cast<Member?>().firstOrNull;
    if (m != null) state = state.copyWith(me: m);
  }

  Future<void> selectMember(Member m) async {
    await store.write(_kMemberId, m.id);
    state = state.copyWith(me: m);
  }

  Future<bool> unlock(String password) async {
    final ok = await unlockFn(password);
    if (ok) state = state.copyWith(unlocked: true);
    return ok;
  }
}

extension _FirstOrNull<E> on Iterable<E> {
  E? get firstOrNull => isEmpty ? null : first;
}
```

（`lib/state/providers.dart` は DioTransport/ApiClient/各リポジトリ/SessionNotifier を Riverpod で束ねる配線。shared_prefs 実装の `SessionStore` を注入。配線は手動確認でよい。）

- [ ] **Step 4: 実行して PASS**

Run: `flutter test test/state/session_test.dart`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/state/ test/state/session_test.dart
git commit -m "feat: session state (member persist + unlock) + providers"
```

---

## Task 15: UI — 本人選択 / ログイン画面（手動確認）

**Files:**
- Create: `lib/ui/login_screen.dart`
- Modify: `lib/main.dart`（起動時 `session.load()` → me 未設定なら login へ）

**Interfaces:**
- Consumes: `sessionProvider`, `kMembers`

- [ ] **Step 1: 実装**
  - `kMembers` をドロップダウン/リストで表示 → 選択で `selectMember` → ホームへ。
  - 既に me があれば skip。設定から変更可能な導線。

- [ ] **Step 2: 手動確認**
  - `flutter run --dart-define=SAILVIZ_BASE_URL=http://localhost:8000`（別窓で sailviz サーバ `SAILVIZ_WRITE_TOKEN=test npm start`）。
  - 名前を選ぶ→再起動で保持されること。

- [ ] **Step 3: Commit**

```bash
git add lib/ui/login_screen.dart lib/main.dart
git commit -m "feat(ui): member select / login screen"
```

---

## Task 16: UI — ホーム（時系列・前回課題/発見）（手動確認）

**Files:**
- Create: `lib/ui/home_screen.dart`
- Test: `test/ui/home_summary_test.dart`（表示用の純関数のみ）

**Interfaces:**
- Consumes: `reflectionRepoProvider`
- Produces: `List<({String date, String issue, String discovery})> summarizeMyCards(List<Reflection> mine)`（純関数・日付降順・issue/discovery を1行化）

- [ ] **Step 1: 失敗するテストを書く（純関数）**

```dart
// test/ui/home_summary_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/ui/home_screen.dart' show summarizeMyCards;
import 'package:sailviz_reflect/core/reflection.dart';

void main() {
  test('日付降順・課題/発見を持つ反省をカード化', () {
    final mine = [
      Reflection.build(id: 'a', createdAt: 100, notes: {'issue': '古い課題'}),
      Reflection.build(id: 'b', createdAt: 300, notes: {'discovery': '新発見'}),
    ];
    final cards = summarizeMyCards(mine);
    expect(cards.first.discovery, '新発見'); // createdAt 大が先頭
    expect(cards.last.issue, '古い課題');
  });
}
```

- [ ] **Step 2: 実行して失敗を確認 → 実装 → PASS**

Run: `flutter test test/ui/home_summary_test.dart`（`summarizeMyCards` を home_screen.dart に純関数として実装）

- [ ] **Step 3: UI 実装・手動確認**
  - カードグリッド／リスト＋「新規反省 +」ボタン。前回の課題・発見を表示。
  - サーバに保存済みの自分の反省が並ぶことを確認。

- [ ] **Step 4: Commit**

```bash
git add lib/ui/home_screen.dart test/ui/home_summary_test.dart
git commit -m "feat(ui): home with my reflections + prev issue/discovery"
```

---

## Task 17: UI — 反省入力（コア）（手動確認）

**Files:**
- Create: `lib/ui/reflection_form_screen.dart`

**Interfaces:**
- Consumes: `reflectionRepoProvider`（`loadMyPreviousRig`, `saveReflection`）、`fetchWind`（amedas）、`kRigFields/kRigLabels/kNoteFields/kNoteLabels`、`guideValuesFor`、`aiRepoProvider`、`sessionProvider`

- [ ] **Step 1: 実装（折りたたみ3セクション）**
  - ① rig: 12 の数値入力。初期表示時に `loadMyPreviousRig(me.fullName)` でプリフィル。各欄に `guideValuesFor(field)` があれば「📖ガイド」チップ。
  - ② 天候: 開いたら practice 時刻で `fetchWind`（`get` は dio で JSON 取得する実装を注入）。取得値を編集可能欄に反映（`source:'amedas'`）。失敗/古い日は空欄＋`source:'manual'`。波高手入力。
  - ③ notes: 5 欄＋自由記述本文。目標欄に **AI補佐ボタン**（Task 18 のパネルを開く）。
  - 保存: `Reflection.build(id:'refl<ts>_<slug>', createdAt:<ts>, people:[me.fullName], wind, practice, rig, waveHeight, notes, text)` → 未 unlock なら unlock ダイアログ → `saveReflection(...)`。
  - 保存前に rig 数値バリデーション（`toNum`）。

- [ ] **Step 2: 手動確認（重要な受け入れ）**
  - 前回 rig がプリフィルされる。
  - 当日反省で天候が自動仮入力される（アメダスが直近日を返す場合）。
  - 保存後、**sailviz Web のダッシュボード（rig）と進捗（notes）に自分の反省が出る**。
  - 空欄 rig が `null` で保存される（Web で NaN 等にならない）。

- [ ] **Step 3: Commit**

```bash
git add lib/ui/reflection_form_screen.dart
git commit -m "feat(ui): reflection form (rig prefill / amedas / notes / save)"
```

---

## Task 18: UI — AI目標補佐パネル（手動確認）

**Files:**
- Create: `lib/ui/ai_assist_sheet.dart`

**Interfaces:**
- Consumes: `aiRepoProvider`, `reflectionRepoProvider`（過去の課題/発見収集）, `roadmapRepoProvider`（大目標/現在地）

- [ ] **Step 1: 実装（4モードのボトムシート）**
  - ① 次の目標提案: 自分の未解決課題（`issueStage` は Web 側管理なので v1 は「直近の issue 群」を素材に）＋最近の discovery ＋ロードマップ大目標/現在地 → `nextGoals(...)` → 候補カード（goal/why/measure）→ タップで目標欄へ挿入。
  - ② ドラフト添削: 現在の目標テキスト → `refineGoal` → refined を提示 → 承認で置換。
  - ③ 参考文献紐付け: v1 は「章要約スクリーニング」までをサーバ経由で行い、出典リンク（東大ヨット部ブログ＋North Sailsガイド）を提示（PDF 直送根拠付けは後フェーズ）。※サーバ `references/` に North Sails 追加が前提（§別作業）。
  - ④ マイルストーン提案: ロードマップ画面から起動（Task 19 と共有可）。
  - 共通: 未 unlock なら unlock ダイアログへ。失敗はトースト。挿入は必ずユーザー操作。「Gemini(Google) に送信されます」の一文を表示。

- [ ] **Step 2: 手動確認**
  - 実サーバ（`GEMINI_API_KEY` 設定済み）で各モードが候補を返し、挿入できること。
  - 未 unlock 時に 401→パスワード導線が出ること。

- [ ] **Step 3: Commit**

```bash
git add lib/ui/ai_assist_sheet.dart
git commit -m "feat(ui): AI goal-assist sheet (4 modes)"
```

---

## Task 19: UI — ロードマップ編集（手動確認）

**Files:**
- Create: `lib/ui/roadmap_screen.dart`

**Interfaces:**
- Consumes: `roadmapRepoProvider`（`loadMyEntry`/`saveMyEntry`）、`roadmapProgress`、`aiRepoProvider`（`proposeMilestones`）

- [ ] **Step 1: 実装**
  - 大目標テキスト編集。マイルストーン: 追加/改名/並替(↑↓)/達成トグル（`done`/`doneAt`）。
  - 現在地（`roadmapProgress` の currentIndex）をステッパー表示。
  - 「AIでマイルストーン提案」→ `proposeMilestones(大目標)` → 候補を選んで追加。
  - 保存は `saveMyEntry(me.fullName, entry)`（re-read マージ）。未 unlock なら unlock。

- [ ] **Step 2: 手動確認**
  - 自分のロードマップを編集・保存 → Web の進捗画面「ロードマップ」表示で自分の段階が出る。
  - 他部員のロードマップが保存で消えないこと（別名簿で2人分編集して相互不変を確認）。

- [ ] **Step 3: Commit**

```bash
git add lib/ui/roadmap_screen.dart
git commit -m "feat(ui): roadmap editor (milestones + AI proposal)"
```

---

## Task 20: 参考ガイド閲覧 UI（手動確認）

**Files:**
- Create: `lib/ui/guide_screen.dart`

**Interfaces:**
- Consumes: `kNorthSailsGuide`, `kGuidePdfUrls`, `guideValuesFor`

- [ ] **Step 1: 実装**
  - 風速帯×セッティングの表を表示。原典 PDF へのリンク（`url_launcher` で外部ブラウザ）。
  - reflection form の「📖ガイド」チップからも該当フィールド値を参照できる導線。

- [ ] **Step 2: 手動確認** — 表示・リンク遷移。

- [ ] **Step 3: Commit**

```bash
git add lib/ui/guide_screen.dart
git commit -m "feat(ui): North Sails guide reference screen"
```

---

## Task 21: エラー処理・下書き・E2E 手動確認

**Files:**
- Create: `lib/data/draft_store.dart`（shared_prefs で反省/ロードマップ下書き）
- Test: `test/data/draft_store_test.dart`（純ロジック：シリアライズ）
- （任意）Modify sailviz `server/auth.js`：Authorization ヘッダ対応1行（cookie が落ちる場合のみ）

**Interfaces:**
- Produces: `String encodeDraft(Map)` / `Map? decodeDraft(String?)`（不正入力は null）

- [ ] **Step 1: 失敗するテスト（下書きのエンコード/デコード）**

```dart
// test/data/draft_store_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:sailviz_reflect/data/draft_store.dart';

void main() {
  test('encode→decode 往復、壊れた入力は null', () {
    final s = encodeDraft({'a': 1});
    expect(decodeDraft(s), {'a': 1});
    expect(decodeDraft('not json'), null);
    expect(decodeDraft(null), null);
  });
}
```

- [ ] **Step 2: 実装 → PASS**

```dart
// lib/data/draft_store.dart
import 'dart:convert';
String encodeDraft(Map m) => jsonEncode(m);
Map? decodeDraft(String? s) {
  if (s == null) return null;
  try {
    final v = jsonDecode(s);
    return v is Map ? v : null;
  } catch (_) {
    return null;
  }
}
```

Run: `flutter test test/data/draft_store_test.dart` → PASS

- [ ] **Step 3: UI に組込み（手動）**
  - 反省/ロードマップ保存失敗時に下書き保存＋次回起動でリトライ提示。
  - 401 で unlock 導線。アメダス/AI 失敗で手入力/手編集フォールバック。

- [ ] **Step 4: E2E 手動確認（ローカル sailviz サーバ相手）**
  1. `SAILVIZ_WRITE_TOKEN=test npm start`（sailviz repo・別窓）。`GEMINI_API_KEY` を設定して AI も検証。
  2. アプリ: 本人選択→反省入力（前回 rig プリフィル・天候仮入力）→保存→Web ダッシュボード/進捗に反映。
  3. AI 目標補佐 各モード。
  4. ロードマップ編集→Web に反映・他部員不変。

- [ ] **Step 5: Commit**

```bash
git add lib/data/draft_store.dart test/data/draft_store_test.dart
git commit -m "feat: local draft store + error fallbacks + e2e verified"
```

---

## フォローアップ（別作業・plan 外）

1. **sailviz 本体**: North Sails ガイド PDF を `src/references/` に追加し、`todaiyacht.js` 同型のインデックスに登録（AI補佐③の候補ソース化）。
2. **North Sails 数値抽出**: Task 9 の `kNorthSailsGuide` の `'要抽出'` を PDF の実値へ更新（各風速帯・各セッティング）。
3. **項目21（録音・要約）**: 後フェーズ。反省フォームに録音入口を足し、STT→要約→notes 反映のパイプラインを別 plan で。

---

## Self-Review

**1. Spec coverage:**
- §1 スコープ（20中心/21後・非目標）→ Task 全体構成＋フォローアップ3で反映。✓
- §3 API 契約 → Task 10（ApiClient）/11/12/13。✓
- §4 データモデル（反省/rig/notes/軽量プロジェクト/ロードマップ/名簿）→ Task 1,2,3,4,7。✓
- §5 画面（本人選択/ホーム/反省入力/ロードマップ/ガイド）→ Task 15,16,17,19,20。✓
- §6.1 プリフィル → Task 5,11。✓ §6.2 アメダス → Task 6,17。✓ §6.3 AI 4機能 → Task 8,13,18,19。✓
- §5.6/§9 North Sails → Task 9,20＋フォローアップ2。✓
- §7 エラー/下書き/Authorization → Task 21。✓
- §9 テスト方針（純関数 TDD＋fake client 契約）→ 各 Task の Step 構成。✓

**2. Placeholder scan:** Task 9 の `'要抽出'` は「構造は確定・値は PDF から更新」と明記し、フォローアップ2で追跡（意図的な残置）。他に TBD/TODO なし。UI タスクは手動確認だがウィジェット責務・受け入れ条件を具体記述。

**3. Type consistency:** `HttpTransport.send(method, path, {body})` / `HttpResp(status,json,headers)` / `ApiClient` メソッド名（getJson/getJsonMap/putJson/postAiComment/unlock/authStatus）は Task 10 定義と 11/12/13 の利用で一致。`Reflection.build`/`toJson`/`fromJson`、`buildReflectionProject`/`reflectionFileName`、`previousRig`、`mergeMyRoadmapKey`/`roadmapProgress`/`emptyRoadmapEntry`、`AiPrompt`/`parse*` は定義タスクと利用タスクで整合。
