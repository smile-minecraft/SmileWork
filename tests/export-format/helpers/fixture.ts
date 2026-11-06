import { join } from "node:path";

import type { PackageInput } from "./types";

const RAW_TASKS = `{
  "version": "4.0",
  "projectId": "fixture-project",
  "projectPath": "/fixture-placeholder/project",
  "activeTaskIds": ["t-old-import"],
  "taskCursor": "t-old-import",
  "tasks": {
    "t-old-plan": {
      "taskId": "t-old-plan",
      "title": "可攜資料格式",
      "state": "COMPLETED",
      "owner": "arch",
      "priority": "high",
      "updatedAt": "2026-10-07T18:01:27.274Z"
    },
    "t-old-format": {
      "taskId": "t-old-format",
      "title": "定義匯出包格式",
      "state": "COMPLETED",
      "owner": "build",
      "priority": "high",
      "updatedAt": "2026-10-07T18:01:27.284Z"
    },
    "t-old-import": {
      "taskId": "t-old-import",
      "title": "實作匯入器",
      "state": "IN_PROGRESS",
      "owner": "build",
      "priority": "medium",
      "updatedAt": "2026-10-07T18:01:27.291Z"
    },
    "t-old-cancel": {
      "taskId": "t-old-cancel",
      "title": "舊格式相容層",
      "state": "CANCELLED",
      "owner": "build",
      "priority": "low",
      "updatedAt": "2026-10-07T18:01:27.295Z"
    },
    "t-old-legacy": {
      "taskId": "t-old-legacy",
      "state": "COMPLETED",
      "owner": "build",
      "priority": "low",
      "updatedAt": "2026-10-07T18:01:27.299Z"
    }
  }
}
`;

const RAW_FIXTURE_TOPIC = `---
title: "測試主題"
description: "去識別化的範例知識"
type: "reference"
pinned: false
source: "manual"
created: "2026-10-07T18:01:27.289Z"
updated: "2026-10-07T18:01:27.289Z"
verified_at: "2026-10-07T18:01:27.289Z"
---

## 內容

這是去識別化的全域範例知識。
`;

const RAW_FORMAT_TOPIC = `---
title: "匯出格式版本升級原則"
description: "格式版本只接受整數，破壞性變更才升版。"
type: "decision"
pinned: true
source: "manual"
created: "2026-10-07T18:01:27.280Z"
updated: "2026-10-08T09:30:00.000Z"
verified_at: "2026-10-08T09:30:00.000Z"
---

## 決定

格式版本只接受整數，破壞性變更才升版。舊版本由轉換工具處理，讀取器不猜測。
`;

const RAW_SHARED_PROJECT = `---
title: "共用主題（專案）"
description: "專案層的共用主題"
type: "reference"
pinned: false
source: "manual"
---

## 內容

這是專案層的版本。
`;

const RAW_SHARED_GLOBAL = `---
title: "共用主題（全域）"
description: "全域層的共用主題"
type: "reference"
pinned: false
source: "manual"
---

## 內容

這是全域層的版本。
`;

const RAW_TEST_OUTPUT = `export-format v1 fixture output
status: ok
`;

const BINARY_BLOB = new Uint8Array([0, 255, 1, 2, 128, 10]);

export function exampleFixtureDir(): string {
  return join(import.meta.dir, "..", "fixtures", "example-export");
}

export function examplePackageInput(): PackageInput {
  return {
    producer: { name: "smilework", version: "0.1.0" },
    source: {
      kind: "ultrawork-v3",
      projectId: "fixture-project",
      projectPath: "/fixture-placeholder/project",
      registryVersion: "4.0",
      layers: ["project", "global"],
    },
    warnings: ["LEGACY_TITLE_FALLBACK: w-task-legacy-title"],
    work: [
      {
        workId: "w-plan-main",
        kind: "plan",
        title: "可攜資料格式",
        status: "done",
        resolution: "completed",
        owner: "arch",
        priority: "high",
        objective: "把舊資料轉成可攜格式。",
        nonGoals: ["不改動來源資料"],
        contextRefs: ["knowledge:k-export-format"],
        scopePaths: ["docs/export-format-v1.md"],
        acceptance: ["格式文件完成", "範例包可驗證"],
        risk: "high",
        review: {
          verdict: "approve",
          reviewer: "momus",
          note: "沒有必須先修的問題",
        },
        acceptanceResults: {
          recordedBy: "arch",
          items: [
            { criterion: "格式文件完成", met: true, evidence: "docs/export-format-v1.md" },
            { criterion: "範例包可驗證", met: true, evidence: "bun test tests/export-format" },
          ],
        },
      },
      {
        workId: "w-task-format",
        kind: "task",
        title: "定義匯出包格式",
        status: "done",
        resolution: "completed",
        owner: "build",
        priority: "high",
        planId: "w-plan-main",
        objective: "定義 manifest、內容檔與 schema。",
        nonGoals: ["不實作匯出器"],
        contextRefs: ["knowledge:k-export-format", "raw/project/tasks.json"],
        scopePaths: ["docs/export-format-v1.md", "schemas/export-v1"],
        acceptance: ["schema 可驗證範例包", "文件定義八個部分"],
        risk: "high",
        review: {
          verdict: "concerns",
          reviewer: "momus",
          note: "需要補分層與 canonical 檢查",
        },
        acceptanceResults: {
          recordedBy: "build",
          items: [
            { criterion: "schema 可驗證範例包", met: true },
            { criterion: "文件定義八個部分", met: true, evidence: "docs/export-format-v1.md" },
          ],
        },
      },
      {
        workId: "w-task-import",
        kind: "task",
        title: "實作匯入器",
        status: "in_progress",
        owner: "build",
        priority: "medium",
        planId: "w-plan-main",
        dependsOn: ["w-task-format"],
        objective: "把匯出包寫進新資料庫。",
        nonGoals: ["不處理遠端同步"],
        contextRefs: ["work:w-task-format"],
        scopePaths: ["src/import"],
        acceptance: ["匯入可重複執行", "舊 ID 對應保留"],
      },
      {
        workId: "w-task-cancel",
        kind: "task",
        title: "舊格式相容層",
        status: "cancelled",
        resolution: "abandoned",
        owner: "build",
        priority: "low",
      },
      {
        workId: "w-task-legacy-title",
        kind: "task",
        title: "w-task-legacy-title",
        status: "done",
        resolution: "completed",
        owner: "build",
        priority: "low",
        objective: "舊資料缺少 title 時保留可讀的標識。",
      },
    ],
    events: [
      {
        eventId: "e-001",
        sequence: 1,
        kind: "created",
        actor: "arch",
        workId: "w-plan-main",
        summary: "建立計畫",
      },
      {
        eventId: "e-002",
        sequence: 2,
        kind: "status_changed",
        actor: "arch",
        workId: "w-plan-main",
        fromStatus: "open",
        toStatus: "in_progress",
      },
      {
        eventId: "e-003",
        sequence: 3,
        kind: "status_changed",
        actor: "arch",
        workId: "w-plan-main",
        fromStatus: "in_progress",
        toStatus: "done",
        resolution: "completed",
      },
      {
        eventId: "e-004",
        sequence: 4,
        kind: "created",
        actor: "build",
        workId: "w-task-format",
        summary: "建立任務",
      },
      {
        eventId: "e-005",
        sequence: 5,
        kind: "status_changed",
        actor: "build",
        workId: "w-task-format",
        fromStatus: "open",
        toStatus: "done",
        resolution: "completed",
      },
      {
        eventId: "e-006",
        sequence: 6,
        kind: "note",
        actor: "build",
        workId: "w-task-import",
        summary: "匯入器依賴格式定案",
      },
      {
        eventId: "e-007",
        sequence: 7,
        kind: "note",
        actor: "build",
        workId: "w-task-legacy-title",
        summary: "舊資料缺 title，匯出時使用 workId",
      },
    ],
    evidence: [
      {
        evidenceId: "e-tests-format",
        workId: "w-task-format",
        kind: "test",
        actor: "build",
        summary: "匯出格式測試通過",
        command: "bun test tests/export-format",
        output: "測試全數通過",
      },
      {
        evidenceId: "e-review-format",
        workId: "w-task-format",
        kind: "review",
        actor: "momus",
        summary: "獨立審查同意",
      },
      {
        evidenceId: "e-artifact-output",
        workId: "w-task-format",
        kind: "artifact",
        actor: "build",
        summary: "測試輸出檔",
        path: "raw/project/evidence/test-output.txt",
      },
    ],
    signals: [
      {
        signalId: "s-format-warning",
        severity: "warning",
        code: "UNMAPPED_STATUS",
        message: "有一個舊狀態無法對應，已保留在 raw/",
        workId: "w-task-import",
        details: { count: 1 },
      },
    ],
    knowledge: [
      {
        knowledgeId: "k-export-format",
        type: "decision",
        layer: "project",
        title: "匯出格式版本升級原則",
        description: "格式版本只接受整數，破壞性變更才升版。",
        pinned: true,
        source: "manual",
        currentVersion: 2,
        versions: [
          {
            version: 1,
            body: "## 決定\n\n格式版本只接受整數。\n",
          },
          {
            version: 2,
            body: "## 決定\n\n格式版本只接受整數，破壞性變更才升版。舊版本由轉換工具處理，讀取器不猜測。\n",
          },
        ],
        tags: ["format", "export"],
      },
      {
        knowledgeId: "k-fixture-topic",
        type: "reference",
        layer: "global",
        title: "測試主題",
        description: "去識別化的範例知識。",
        pinned: false,
        source: "manual",
        currentVersion: 1,
        versions: [
          {
            version: 1,
            body: "## 內容\n\n這是去識別化的全域範例知識。\n",
          },
        ],
      },
      {
        knowledgeId: "k-shared-project",
        type: "reference",
        layer: "project",
        title: "共用主題（專案）",
        description: "專案層的共用主題。",
        pinned: false,
        source: "manual",
        currentVersion: 1,
        versions: [
          {
            version: 1,
            body: "## 內容\n\n這是專案層的版本。\n",
          },
        ],
      },
      {
        knowledgeId: "k-shared-global",
        type: "reference",
        layer: "global",
        title: "共用主題（全域）",
        description: "全域層的共用主題。",
        pinned: false,
        source: "manual",
        currentVersion: 1,
        versions: [
          {
            version: 1,
            body: "## 內容\n\n這是全域層的版本。\n",
          },
        ],
      },
    ],
    mapping: [
      {
        entity: "work",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "t-old-plan",
        sourceRecord: "/tasks/t-old-plan",
        targetId: "w-plan-main",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "work",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "t-old-format",
        sourceRecord: "/tasks/t-old-format",
        targetId: "w-task-format",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "work",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "t-old-import",
        sourceRecord: "/tasks/t-old-import",
        targetId: "w-task-import",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "work",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "t-old-cancel",
        sourceRecord: "/tasks/t-old-cancel",
        targetId: "w-task-cancel",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "work",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "t-old-legacy",
        sourceRecord: "/tasks/t-old-legacy",
        targetId: "w-task-legacy-title",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "knowledge",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "export-format-decision",
        sourceRecord: "frontmatter",
        targetId: "k-export-format",
        sourceRef: "raw/project/memory/topics/export-format-decision.md",
      },
      {
        entity: "knowledge",
        layer: "global",
        sourceRoot: "raw/global",
        sourceId: "fixture-topic",
        sourceRecord: "frontmatter",
        targetId: "k-fixture-topic",
        sourceRef: "raw/global/memory/topics/fixture-topic.md",
      },
      {
        entity: "knowledge",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "shared-topic",
        sourceRecord: "frontmatter",
        targetId: "k-shared-project",
        sourceRef: "raw/project/memory/topics/shared-topic.md",
      },
      {
        entity: "knowledge",
        layer: "global",
        sourceRoot: "raw/global",
        sourceId: "shared-topic",
        sourceRecord: "frontmatter",
        targetId: "k-shared-global",
        sourceRef: "raw/global/memory/topics/shared-topic.md",
      },
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "tasks.json",
        targetId: "raw/project/tasks.json",
        sourceRef: "raw/project/tasks.json",
      },
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "memory/topics/export-format-decision.md",
        targetId: "raw/project/memory/topics/export-format-decision.md",
        sourceRef: "raw/project/memory/topics/export-format-decision.md",
      },
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "memory/topics/shared-topic.md",
        targetId: "raw/project/memory/topics/shared-topic.md",
        sourceRef: "raw/project/memory/topics/shared-topic.md",
      },
      {
        entity: "raw",
        layer: "global",
        sourceRoot: "raw/global",
        sourceId: "memory/topics/fixture-topic.md",
        targetId: "raw/global/memory/topics/fixture-topic.md",
        sourceRef: "raw/global/memory/topics/fixture-topic.md",
      },
      {
        entity: "raw",
        layer: "global",
        sourceRoot: "raw/global",
        sourceId: "memory/topics/shared-topic.md",
        targetId: "raw/global/memory/topics/shared-topic.md",
        sourceRef: "raw/global/memory/topics/shared-topic.md",
      },
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "evidence/test-output.txt",
        targetId: "raw/project/evidence/test-output.txt",
        sourceRef: "raw/project/evidence/test-output.txt",
      },
      {
        entity: "raw",
        layer: "project",
        sourceRoot: "raw/project",
        sourceId: "assets/blob.bin",
        targetId: "raw/project/assets/blob.bin",
        sourceRef: "raw/project/assets/blob.bin",
      },
    ],
    raw: [
      { layer: "project", path: "tasks.json", body: RAW_TASKS },
      {
        layer: "project",
        path: "memory/topics/export-format-decision.md",
        body: RAW_FORMAT_TOPIC,
      },
      { layer: "project", path: "memory/topics/shared-topic.md", body: RAW_SHARED_PROJECT },
      { layer: "global", path: "memory/topics/fixture-topic.md", body: RAW_FIXTURE_TOPIC },
      { layer: "global", path: "memory/topics/shared-topic.md", body: RAW_SHARED_GLOBAL },
      { layer: "project", path: "evidence/test-output.txt", body: RAW_TEST_OUTPUT },
      { layer: "project", path: "assets/blob.bin", body: BINARY_BLOB },
    ],
  };
}
