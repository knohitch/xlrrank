import { getDb } from "./client.js";
import { eq } from "drizzle-orm";
import {
  users,
  platforms,
  socialAccounts,
  people,
  personIdentifiers,
  content,
  contentMetrics,
  interactions,
  relationships,
  relationshipEvents,
  relationshipPipelines,
  relationshipStages,
  topics,
  contentTopics,
  opportunities,
  trends,
  recommendations,
  notifications,
  supportTickets,
  supportMessages,
} from "./schema/index.js";
import { hashPassword } from "@xlrrank/auth";
import { assignRole, seedRbac } from "./seed-rbac.js";

const DEMO_PREFIX = "demo_";

function isDemoRecord(id: string): boolean {
  return id.startsWith(DEMO_PREFIX);
}

export function assertDemoSeedAllowed(): void {
  const env = process.env.NODE_ENV ?? "development";
  const databaseUrl = process.env.DATABASE_URL ?? "";
  const explicitlyAllowed = process.env.ALLOW_DEMO_SEED === "true";
  const safeEnvironment = env === "development" || env === "test";
  const safeDatabase =
    databaseUrl.includes("localhost") ||
    databaseUrl.includes("127.0.0.1") ||
    databaseUrl.includes("xlrrank_demo") ||
    databaseUrl.includes("xlrrank_test") ||
    databaseUrl.includes("xlrrank_audit");

  if (!explicitlyAllowed || !safeEnvironment || !safeDatabase) {
    throw new Error(
      "Demo seed is disabled unless ALLOW_DEMO_SEED=true, NODE_ENV is development/test, and DATABASE_URL points to a demo/test/audit database.",
    );
  }
}

export async function seedDemoData(): Promise<void> {
  assertDemoSeedAllowed();
  const db = getDb();

  await seedRbac();

  const passwordHash = await hashPassword("Demo1234");

  const [demoUser] = await db
    .insert(users)
    .values({
      email: "demo@xlrrank.local",
      passwordHash,
      displayName: "Demo User",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();

  if (!demoUser) {
    console.log("Demo user already exists, skipping seed.");
    return;
  }

  await assignRole(demoUser.id, "USER");

  const platformSlugs = ["x", "instagram", "facebook", "linkedin", "reddit"];
  const platformRecords: Array<{ id: string; slug: string }> = [];
  for (const slug of platformSlugs) {
    const [p] = await db
      .insert(platforms)
      .values({ slug, displayName: slug.charAt(0).toUpperCase() + slug.slice(1) })
      .onConflictDoNothing()
      .returning();
    if (p) platformRecords.push({ id: p.id, slug });
    else {
      const existing = await db.select().from(platforms).where(eq(platforms.slug, slug)).limit(1);
      if (existing[0]) platformRecords.push({ id: existing[0].id, slug });
    }
  }

  const xPlatform = platformRecords.find((p) => p.slug === "x");
  const liPlatform = platformRecords.find((p) => p.slug === "linkedin");

  if (xPlatform) {
    await db
      .insert(socialAccounts)
      .values({
        platformId: xPlatform.id,
        userId: demoUser.id,
        externalId: "demo_x_user",
        handle: "demo_user",
        displayName: "Demo User",
        status: "DEMO",
        bio: "Founder interested in African fintech, SaaS, and AI",
      })
      .onConflictDoNothing();
  }

  const demoPeople = [
    { name: "Sarah Adams", bio: "Fintech founder, cross-border payments", location: "Lagos" },
    { name: "James Chen", bio: "VC partner focused on B2B SaaS", location: "San Francisco" },
    { name: "Aisha Okafor", bio: "Compliance expert, African markets", location: "Nairobi" },
    { name: "Marcus Johnson", bio: "CRM product lead, enterprise sales", location: "London" },
    { name: "Elena Rodriguez", bio: "AI researcher, NLP and social graphs", location: "Berlin" },
  ];

  const personRecords: Array<{ id: string; name: string }> = [];
  for (const p of demoPeople) {
    const [record] = await db
      .insert(people)
      .values({ name: p.name, bio: p.bio, location: p.location, confidence: "probable" })
      .onConflictDoNothing()
      .returning();
    if (record) personRecords.push({ id: record.id, name: record.name });
  }

  const demoTopics = [
    "fintech",
    "cross-border payments",
    "compliance",
    "SaaS",
    "CRM",
    "AI",
    "social graphs",
    "venture capital",
    "African markets",
    "B2B",
  ];
  const topicRecords: Array<{ id: string; label: string }> = [];
  for (const t of demoTopics) {
    const [record] = await db
      .insert(topics)
      .values({ label: t, slug: t.toLowerCase().replace(/\s+/g, "-") })
      .onConflictDoNothing()
      .returning();
    if (record) topicRecords.push({ id: record.id, label: record.label });
  }

  if (xPlatform) {
    const account = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.userId, demoUser.id))
      .limit(1);
    if (account[0]) {
      const demoContents = [
        {
          body: "Just launched our cross-border payments API. Compliance was the hardest part.",
          contentType: "short_post",
        },
        {
          body: "The future of African fintech is in stablecoin settlement. Thread:",
          contentType: "thread",
        },
        {
          body: "CRM pricing is broken. Enterprise shouldn't mean expensive.",
          contentType: "short_post",
        },
      ];
      for (const c of demoContents) {
        const [contentRecord] = await db
          .insert(content)
          .values({
            platformId: xPlatform.id,
            authorAccountId: account[0].id,
            externalId: `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            body: c.body,
            contentType: c.contentType,
          })
          .onConflictDoNothing()
          .returning();

        if (contentRecord) {
          await db.insert(contentMetrics).values({
            contentId: contentRecord.id,
            likes: Math.floor(Math.random() * 100),
            comments: Math.floor(Math.random() * 20),
            shares: Math.floor(Math.random() * 10),
            impressions: Math.floor(Math.random() * 1000),
          });
        }
      }
    }
  }

  if (personRecords.length >= 2) {
    const [pipeline] = await db
      .insert(relationshipPipelines)
      .values({ name: "Default", isDefault: true })
      .onConflictDoNothing()
      .returning();

    if (pipeline) {
      const stages = [
        "Discovered",
        "Following",
        "Engaged",
        "Mutual Engagement",
        "Familiar",
        "Conversation",
        "Relationship",
      ];
      for (let i = 0; i < stages.length; i++) {
        await db
          .insert(relationshipStages)
          .values({
            pipelineId: pipeline.id,
            key: stages[i]!.toLowerCase().replace(/\s+/g, "_"),
            label: stages[i]!,
            orderIndex: i,
          })
          .onConflictDoNothing();
      }

      const [rel] = await db
        .insert(relationships)
        .values({
          userId: demoUser.id,
          fromPersonId: personRecords[0]!.id,
          toPersonId: personRecords[1]!.id,
          pipelineId: pipeline.id,
          stageKey: "engaged",
          strength: 72,
          momentum: 15,
          tier: "A",
        })
        .onConflictDoNothing()
        .returning();

      if (rel) {
        await db.insert(relationshipEvents).values([
          {
            relationshipId: rel.id,
            eventType: "followed",
            sourceKind: "OBSERVED",
            occurredAt: new Date(Date.now() - 30 * 86400000),
          },
          {
            relationshipId: rel.id,
            eventType: "commented",
            sourceKind: "OBSERVED",
            occurredAt: new Date(Date.now() - 15 * 86400000),
          },
          {
            relationshipId: rel.id,
            eventType: "replied",
            sourceKind: "OBSERVED",
            occurredAt: new Date(Date.now() - 5 * 86400000),
          },
        ]);
      }
    }
  }

  const oppTypes = ["conversation", "commercial_intent", "content_gap"];
  for (const type of oppTypes) {
    await db
      .insert(opportunities)
      .values({
        userId: demoUser.id,
        typeKey: type,
        title: `Demo ${type} opportunity`,
        description: `This is a demo ${type} opportunity for testing.`,
        score: Math.floor(Math.random() * 40) + 60,
        confidence: 0.85,
        status: "OPEN",
      })
      .onConflictDoNothing();
  }

  await db.insert(notifications).values([
    {
      userId: demoUser.id,
      type: "HIGH_VALUE_OPPORTUNITY",
      title: "New conversation opportunity",
      body: "Sarah Adams started a thread about cross-border payments.",
    },
    {
      userId: demoUser.id,
      type: "RELATIONSHIP_COOLING",
      title: "Relationship cooling",
      body: "Your relationship with James Chen has momentum -15.",
    },
    {
      userId: demoUser.id,
      type: "TREND_ALERT",
      title: "Trending topic",
      body: "African fintech discussion is accelerating in your network.",
    },
  ]);

  console.log("Demo data seeded successfully.");
}

export async function resetDemoData(): Promise<void> {
  assertDemoSeedAllowed();
  const db = getDb();
  const [demoUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "demo@xlrrank.local"))
    .limit(1);
  if (!demoUser) {
    console.log("Demo user not found, nothing to reset.");
    return;
  }
  await db.delete(users).where(eq(users.id, demoUser.id));
  console.log("Demo data reset. Run seedDemoData() to re-seed.");
}
