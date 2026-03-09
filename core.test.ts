import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, createChannel, insertMessage, insertMessages, generateId, getThread, getUnreadMessages, queryMessages, parseAuthor, ensureMember, getMembers, getAgentConfigs, rebuildMembers, getTasks, getMemories, getSummaries } from "./src/db";
import { writeConfig, readReadCursor, writeReadCursor, readReaderCursor, writeReaderCursor } from "./src/config";

function makeTmpChatDir(suffix: string): string {
  const dir = `/tmp/qqchat-test-${suffix}-${Date.now()}`;
  const chatDir = join(dir, ".chat");
  mkdirSync(chatDir, { recursive: true });
  return chatDir;
}

// -------------------------------------------------------------------
describe("thread", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("thread");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");

    // Root message
    insertMessage(db, { id: "root_001", channel: "general", author: "kensaku", content: "What do you think?", reply_to: null });
    // Replies
    insertMessage(db, { id: "reply_001", channel: "general", author: "agent@kensaku", content: "I think it's great", reply_to: "root_001" });
    insertMessage(db, { id: "reply_002", channel: "general", author: "agent:Opus@kensaku", content: "Agreed", reply_to: "root_001" });
    // Unrelated message
    insertMessage(db, { id: "other_001", channel: "general", author: "kensaku", content: "Something else", reply_to: null });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("returns root and its replies", () => {
    const db = openDb(chatDir);
    const { root, replies } = getThread(db, "root_001");
    db.close();

    expect(root).not.toBeNull();
    expect(root!.content).toBe("What do you think?");
    expect(replies.length).toBe(2);
    expect(replies[0].content).toBe("I think it's great");
    expect(replies[1].content).toBe("Agreed");
  });

  test("returns null root for non-existent message", () => {
    const db = openDb(chatDir);
    const { root, replies } = getThread(db, "nonexistent");
    db.close();

    expect(root).toBeNull();
    expect(replies.length).toBe(0);
  });
});

// -------------------------------------------------------------------
describe("unread", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("unread");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");
    createChannel(db, "dev", "Dev");

    insertMessage(db, { id: "aaa_001", channel: "general", author: "kensaku", content: "msg1", reply_to: null });
    insertMessage(db, { id: "bbb_002", channel: "dev", author: "agent@kensaku", content: "msg2", reply_to: null });
    insertMessage(db, { id: "ccc_003", channel: "general", author: "kensaku", content: "msg3", reply_to: null });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("returns all non-system messages when no cursor", () => {
    const db = openDb(chatDir);
    const msgs = getUnreadMessages(db, "");
    db.close();
    expect(msgs.length).toBe(3);
  });

  test("returns only messages after cursor", () => {
    const db = openDb(chatDir);
    const msgs = getUnreadMessages(db, "bbb_002");
    db.close();
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("msg3");
  });

  test("excludes _system channel", () => {
    const db = openDb(chatDir);
    insertMessage(db, { id: "sys_001", channel: "_system", author: "kensaku", content: "system msg", reply_to: null });
    const msgs = getUnreadMessages(db, "");
    db.close();
    expect(msgs.every(m => m.channel !== "_system")).toBe(true);
  });

  test("legacy read cursor persists", () => {
    writeReadCursor(chatDir, "bbb_002");
    const cursor = readReadCursor(chatDir);
    expect(cursor).toBe("bbb_002");
  });

  test("agent channel filtering: subscribed channels + mentions", () => {
    const db = openDb(chatDir);
    insertMessage(db, { id: "ddd_004", channel: "general", author: "kensaku", content: "@Opus check this", reply_to: null });
    insertMessage(db, { id: "eee_005", channel: "dev", author: "kensaku", content: "@Opus also this", reply_to: null });

    const msgs = getUnreadMessages(db, "", { channels: ["general"], mentionName: "Opus" });
    db.close();

    const ids = msgs.map(m => m.id);
    expect(ids).toContain("aaa_001");
    expect(ids).toContain("ccc_003");
    expect(ids).toContain("ddd_004");
    expect(ids).toContain("eee_005");
    expect(ids).not.toContain("bbb_002");
  });

  test("agent with empty channels: mentions only", () => {
    const db = openDb(chatDir);
    insertMessage(db, { id: "ddd_004", channel: "general", author: "kensaku", content: "@Opus check this", reply_to: null });

    const msgs = getUnreadMessages(db, "", { channels: [], mentionName: "Opus" });
    db.close();

    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("@Opus check this");
  });

  test("human mode: all channels except _system", () => {
    const db = openDb(chatDir);
    insertMessage(db, { id: "sys_001", channel: "_system", author: "kensaku", content: "system", reply_to: null });
    const msgs = getUnreadMessages(db, "");
    db.close();

    expect(msgs.length).toBe(3);
    expect(msgs.every(m => m.channel !== "_system")).toBe(true);
  });
});

// -------------------------------------------------------------------
describe("per-reader cursor", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("per-reader");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");
    createChannel(db, "planning", "Planning");

    insertMessage(db, { id: "aaa_001", channel: "general", author: "kensaku", content: "msg1", reply_to: null });
    insertMessage(db, { id: "bbb_002", channel: "planning", author: "kensaku", content: "msg2", reply_to: null });
    insertMessage(db, { id: "ccc_003", channel: "general", author: "kensaku", content: "msg3 @directore", reply_to: null });

    ensureMember(db, "kensaku");
    insertMessage(db, {
      id: "agent_cfg_001", channel: "_system", author: "kensaku",
      content: "Register agent: directore",
      metadata: JSON.stringify({ agent_config: { name: "directore", role: "director", channels: ["planning"] } }),
    });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("cursor isolation: reader A does not affect reader B", () => {
    writeReaderCursor(chatDir, "kensaku", "bbb_002");
    writeReaderCursor(chatDir, "directore", "aaa_001");

    expect(readReaderCursor(chatDir, "kensaku")).toBe("bbb_002");
    expect(readReaderCursor(chatDir, "directore")).toBe("aaa_001");

    writeReaderCursor(chatDir, "kensaku", "ccc_003");
    expect(readReaderCursor(chatDir, "kensaku")).toBe("ccc_003");
    expect(readReaderCursor(chatDir, "directore")).toBe("aaa_001");
  });

  test("cursor persistence in read_cursors/ directory", () => {
    writeReaderCursor(chatDir, "kensaku", "aaa_001");
    writeReaderCursor(chatDir, "directore", "bbb_002");

    expect(readReaderCursor(chatDir, "kensaku")).toBe("aaa_001");
    expect(readReaderCursor(chatDir, "directore")).toBe("bbb_002");
    expect(readReaderCursor(chatDir, "unknown")).toBe("");
  });

  test("empty cursor returns empty string for new reader", () => {
    expect(readReaderCursor(chatDir, "new-agent")).toBe("");
  });

  test("agent gets subscribed channels + mentions from other channels", () => {
    const db = openDb(chatDir);
    const agents = getAgentConfigs(db);
    const agentConfig = agents["directore"]!;

    const msgs = getUnreadMessages(db, "", { channels: agentConfig.channels, mentionName: "directore" });
    db.close();

    expect(msgs.some(m => m.channel === "planning")).toBe(true);
    expect(msgs.some(m => m.content.includes("@directore"))).toBe(true);
    expect(msgs.filter(m => m.channel === "general" && !m.content.includes("@directore")).length).toBe(0);
  });

  test("human gets all channels except _system", () => {
    const db = openDb(chatDir);
    const msgs = getUnreadMessages(db, "");
    db.close();

    expect(msgs.length).toBe(3);
    expect(msgs.every(m => m.channel !== "_system")).toBe(true);
  });
});

// -------------------------------------------------------------------
describe("rebuildMembers preserves renamed members", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("rebuild");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");
    insertMessage(db, { id: "r_001", channel: "general", author: "agent:OldName@kensaku", content: "hello", reply_to: null });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("does not delete manually added members", () => {
    const db = openDb(chatDir);
    // Simulate rename: delete old, insert new
    db.run("DELETE FROM members WHERE name = ?", ["OldName"]);
    ensureMember(db, "agent:NewName@kensaku");

    // Rebuild should add OldName back but keep NewName
    rebuildMembers(db);
    const members = getMembers(db);
    db.close();

    const names = members.map(m => m.name).sort();
    expect(names).toContain("NewName");
    expect(names).toContain("OldName");
  });
});

// -------------------------------------------------------------------
describe("metadata", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("metadata");
    const db = openDb(chatDir);
    createChannel(db, "dev", "Dev");
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("stores and retrieves metadata", () => {
    const db = openDb(chatDir);
    const meta = JSON.stringify({ files: [{ path: "src/db.ts", content: "..." }] });
    insertMessage(db, { id: "meta_001", channel: "dev", author: "agent:Opus@kensaku", content: "check this", reply_to: null, metadata: meta });

    const msgs = queryMessages(db, "dev", { last: 1 });
    db.close();

    expect(msgs[0].metadata).toBe(meta);
    const parsed = JSON.parse(msgs[0].metadata!);
    expect(parsed.files[0].path).toBe("src/db.ts");
  });

  test("metadata is null by default", () => {
    const db = openDb(chatDir);
    insertMessage(db, { id: "nometa_001", channel: "dev", author: "kensaku", content: "plain msg", reply_to: null });

    const msgs = queryMessages(db, "dev", { last: 1 });
    db.close();

    expect(msgs[0].metadata).toBeNull();
  });

  test("bulk insert preserves metadata", () => {
    const db = openDb(chatDir);
    const meta = JSON.stringify({ diff: "+added line" });
    insertMessages(db, [
      { id: "bulk_001", channel: "dev", author: "agent@kensaku", content: "with meta", reply_to: null, metadata: meta },
      { id: "bulk_002", channel: "dev", author: "kensaku", content: "without meta", reply_to: null },
    ]);

    const msgs = queryMessages(db, "dev");
    db.close();

    expect(msgs[0].metadata).toBe(meta);
    expect(msgs[1].metadata).toBeNull();
  });
});

// -------------------------------------------------------------------
describe("mention filter", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("mention");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");

    insertMessage(db, { id: "m_001", channel: "general", author: "kensaku", content: "@Opus このコード見て", reply_to: null });
    insertMessage(db, { id: "m_002", channel: "general", author: "agent:Opus@kensaku", content: "了解です", reply_to: null });
    insertMessage(db, { id: "m_003", channel: "general", author: "kensaku", content: "@Sonnet こっちも頼む", reply_to: null });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("filters messages by mention", () => {
    const db = openDb(chatDir);
    const msgs = queryMessages(db, "general", { mention: "Opus" });
    db.close();

    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain("@Opus");
  });
});

// -------------------------------------------------------------------
describe("parseAuthor", () => {
  test("parses named agent", () => {
    expect(parseAuthor("agent:Opus@kensaku")).toEqual({ name: "Opus", type: "agent" });
  });

  test("parses unnamed agent", () => {
    expect(parseAuthor("agent@kensaku")).toEqual({ name: "kensaku", type: "agent" });
  });

  test("parses human", () => {
    expect(parseAuthor("kensaku")).toEqual({ name: "kensaku", type: "human" });
  });

  test("parses named agent without identity", () => {
    expect(parseAuthor("agent:Director")).toEqual({ name: "Director", type: "agent" });
  });
});

// -------------------------------------------------------------------
describe("members", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("members");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("registers human member", () => {
    const db = openDb(chatDir);
    ensureMember(db, "kensaku");
    const members = getMembers(db);
    db.close();

    expect(members.length).toBe(1);
    expect(members[0].name).toBe("kensaku");
    expect(members[0].type).toBe("human");
  });

  test("registers named agent as display name", () => {
    const db = openDb(chatDir);
    ensureMember(db, "agent:Opus@kensaku");
    const members = getMembers(db);
    db.close();

    expect(members.length).toBe(1);
    expect(members[0].name).toBe("Opus");
    expect(members[0].type).toBe("agent");
  });

  test("deduplicates members", () => {
    const db = openDb(chatDir);
    ensureMember(db, "agent:Opus@kensaku");
    ensureMember(db, "agent:Opus@kensaku");
    ensureMember(db, "kensaku");
    const members = getMembers(db);
    db.close();

    expect(members.length).toBe(2);
  });

  test("different agents get separate entries", () => {
    const db = openDb(chatDir);
    ensureMember(db, "agent:Opus@kensaku");
    ensureMember(db, "agent:Director@kensaku");
    ensureMember(db, "kensaku");
    const members = getMembers(db);
    db.close();

    expect(members.length).toBe(3);
    const names = members.map(m => m.name).sort();
    expect(names).toEqual(["Director", "Opus", "kensaku"]);
  });
});

// -------------------------------------------------------------------
describe("tasks", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("tasks");
    const db = openDb(chatDir);
    createChannel(db, "general", "General");

    // Task message
    insertMessage(db, {
      id: "task_001", channel: "general", author: "kensaku",
      content: "[Task] Fix bug → @Opus",
      metadata: JSON.stringify({ task: { name: "Fix bug", assignee: "Opus", detail: "", status: "pending" } }),
    });
    // Non-task message
    insertMessage(db, {
      id: "msg_001", channel: "general", author: "kensaku",
      content: "Hello", reply_to: null,
    });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("getTasks returns only task messages", () => {
    const db = openDb(chatDir);
    const tasks = getTasks(db);
    db.close();

    expect(tasks.length).toBe(1);
    expect(tasks[0].name).toBe("Fix bug");
    expect(tasks[0].status).toBe("pending");
  });

  test("getTasks reflects latest status update", () => {
    const db = openDb(chatDir);
    insertMessage(db, {
      id: "upd_001", channel: "general", author: "agent:Opus@kensaku",
      content: "[Task] Fix bug → active", reply_to: "task_001",
      metadata: JSON.stringify({ task_update: { status: "active" } }),
    });
    const tasks = getTasks(db);
    db.close();

    expect(tasks[0].status).toBe("active");
  });

  test("getTasks filters by status", () => {
    const db = openDb(chatDir);
    const pending = getTasks(db, "pending");
    const done = getTasks(db, "done");
    db.close();

    expect(pending.length).toBe(1);
    expect(done.length).toBe(0);
  });

  test("task_update on non-root is ignored by getTasks", () => {
    const db = openDb(chatDir);
    // Update replying to the update (not root task) — should not affect status
    insertMessage(db, {
      id: "upd_001", channel: "general", author: "agent:Opus@kensaku",
      content: "[Task] Fix bug → active", reply_to: "task_001",
      metadata: JSON.stringify({ task_update: { status: "active" } }),
    });
    insertMessage(db, {
      id: "upd_002", channel: "general", author: "agent:Opus@kensaku",
      content: "[Task] Fix bug → done", reply_to: "upd_001",
      metadata: JSON.stringify({ task_update: { status: "done" } }),
    });
    const tasks = getTasks(db);
    db.close();

    // Only direct replies to root are tracked, so status should be "active" not "done"
    expect(tasks[0].status).toBe("active");
  });
});

// -------------------------------------------------------------------
describe("memories", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("memories");
    const db = openDb(chatDir);
    createChannel(db, "_memory", "Agent memories");

    insertMessage(db, {
      id: "mem_001", channel: "_memory", author: "agent:Opus@kensaku",
      content: "kensakuはシンプルさ最優先",
      metadata: JSON.stringify({ memory: { tags: ["decision"] } }),
    });
    insertMessage(db, {
      id: "mem_002", channel: "_memory", author: "agent:Director@kensaku",
      content: "PRはfeatureブランチ→マージの流れ",
      metadata: JSON.stringify({ memory: { tags: ["decision", "workflow"] } }),
    });
    insertMessage(db, {
      id: "mem_003", channel: "_memory", author: "agent:Opus@kensaku",
      content: "Bunを使う。Node.jsは使わない",
      metadata: JSON.stringify({ memory: { tags: ["context"] } }),
    });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("getMemories returns all memories", () => {
    const db = openDb(chatDir);
    const memories = getMemories(db);
    db.close();

    expect(memories.length).toBe(3);
    expect(memories[0].content).toBe("kensakuはシンプルさ最優先");
    expect(memories[0].agent).toBe("Opus");
    expect(memories[0].tags).toEqual(["decision"]);
  });

  test("getMemories filters by agent", () => {
    const db = openDb(chatDir);
    const memories = getMemories(db, { agent: "Opus" });
    db.close();

    expect(memories.length).toBe(2);
    expect(memories.every(m => m.agent === "Opus")).toBe(true);
  });

  test("getMemories filters by tag", () => {
    const db = openDb(chatDir);
    const memories = getMemories(db, { tag: "workflow" });
    db.close();

    expect(memories.length).toBe(1);
    expect(memories[0].content).toContain("featureブランチ");
  });

  test("getMemories filters by search", () => {
    const db = openDb(chatDir);
    const memories = getMemories(db, { search: "Bun" });
    db.close();

    expect(memories.length).toBe(1);
    expect(memories[0].content).toContain("Bunを使う");
  });

  test("getMemories limits results", () => {
    const db = openDb(chatDir);
    const memories = getMemories(db, { last: 1 });
    db.close();

    expect(memories.length).toBe(1);
    expect(memories[0].content).toContain("Bunを使う"); // last one
  });
});

// -------------------------------------------------------------------
describe("summaries", () => {
  let chatDir: string;

  beforeEach(() => {
    chatDir = makeTmpChatDir("summaries");
    const db = openDb(chatDir);
    createChannel(db, "_summary", "Channel summaries");

    insertMessage(db, {
      id: "sum_001", channel: "_summary", author: "agent:Director@kensaku",
      content: "タスク管理機能がリリースされた。PRレビューフローが確立。",
      metadata: JSON.stringify({ summary: { channel: "dev", period: "24h", message_count: 15 } }),
    });
    insertMessage(db, {
      id: "sum_002", channel: "_summary", author: "agent:Director@kensaku",
      content: "命名はQQchatに決定。X投稿を開始。",
      metadata: JSON.stringify({ summary: { channel: "marketing", period: "12h", message_count: 8 } }),
    });
    insertMessage(db, {
      id: "sum_003", channel: "_summary", author: "agent:Director@kensaku",
      content: "エージェントメモリ機能の企画が承認された。",
      metadata: JSON.stringify({ summary: { channel: "dev", period: "6h", message_count: 5 } }),
    });
    db.close();
  });

  afterEach(() => {
    rmSync(join(chatDir, ".."), { recursive: true, force: true });
  });

  test("getSummaries returns all summaries", () => {
    const db = openDb(chatDir);
    const summaries = getSummaries(db);
    db.close();

    expect(summaries.length).toBe(3);
    expect(summaries[0].channel).toBe("dev");
    expect(summaries[0].period).toBe("24h");
    expect(summaries[0].message_count).toBe(15);
  });

  test("getSummaries filters by channel", () => {
    const db = openDb(chatDir);
    const summaries = getSummaries(db, "dev");
    db.close();

    expect(summaries.length).toBe(2);
    expect(summaries.every(s => s.channel === "dev")).toBe(true);
  });

  test("getSummaries limits results (latest)", () => {
    const db = openDb(chatDir);
    const summaries = getSummaries(db, "dev", 1);
    db.close();

    expect(summaries.length).toBe(1);
    expect(summaries[0].content).toContain("エージェントメモリ");
  });
});
