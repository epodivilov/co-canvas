import { type APIRequestContext, request } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/** Materialises a board on the hub the way a previous session or the API would. */
async function seedBoard(
  hubUrl: string,
  slug: string,
  patch?: { title?: string; archived?: boolean },
): Promise<void> {
  const api: APIRequestContext = await request.newContext();
  try {
    const created = await api.post(`${hubUrl}/api/boards`, { data: { slug } });
    expect(created.ok(), `seeding ${slug} failed: ${created.status()}`).toBeTruthy();
    if (patch !== undefined) {
      const patched = await api.patch(`${hubUrl}/api/boards/${slug}`, { data: patch });
      expect(patched.ok(), `patching ${slug} failed: ${patched.status()}`).toBeTruthy();
    }
  } finally {
    await api.dispose();
  }
}

function item(page: import("@playwright/test").Page, slug: string) {
  return page.locator(`[data-testid="board-item"][data-slug="${slug}"]`);
}

test.describe("board overview", () => {
  test("lists boards with a title or a slug fallback (R1)", async ({ overview, hub }) => {
    await seedBoard(hub.url, "auth-redesign", { title: "Auth redesign" });
    await seedBoard(hub.url, "scratch");

    const page = await overview.open();

    await expect(item(page, "auth-redesign").getByTestId("board-title")).toHaveText(
      "Auth redesign",
    );
    await expect(item(page, "scratch").getByTestId("board-title")).toHaveText("scratch");
  });

  test("shows an empty state when the hub holds no board (R1)", async ({ overview }) => {
    const page = await overview.open();

    await expect(page.getByTestId("board-empty")).toBeVisible();
    await expect(page.getByTestId("board-item")).toHaveCount(0);
  });

  test("opens a board and connects its canvas (R2)", async ({ overview, hub }) => {
    await seedBoard(hub.url, "sprint-plan");

    const page = await overview.open();
    await item(page, "sprint-plan").getByTestId("board-open").click();

    await expect(page).toHaveURL(/\/room\/sprint-plan(\?|$)/);
    await expect(page.locator(".excalidraw")).toHaveCount(1);
    await expect(page.locator("[data-connection-state]")).toHaveAttribute(
      "data-connection-state",
      "connected",
    );
  });

  test("creates a board from a valid slug and lists it afterwards (R3)", async ({ overview }) => {
    const page = await overview.open();
    await page.getByTestId("create-slug").fill("fresh-idea");
    await page.getByTestId("create-submit").click();

    await expect(page).toHaveURL(/\/room\/fresh-idea(\?|$)/);
    await expect(page.locator("[data-connection-state]")).toHaveAttribute(
      "data-connection-state",
      "connected",
    );

    const again = await overview.open();
    await expect(item(again, "fresh-idea")).toBeVisible();
  });

  test("refuses an invalid slug with a message and stays on the overview (R3)", async ({
    overview,
  }) => {
    const page = await overview.open();
    await page.getByTestId("create-slug").fill("Not A Slug");
    await page.getByTestId("create-submit").click();

    await expect(page.getByTestId("create-error")).toBeVisible();
    await expect(page).toHaveURL(/\/(\?|$)/);
  });

  test("renames a board's title (R4)", async ({ overview, hub }) => {
    await seedBoard(hub.url, "roadmap");

    const page = await overview.open();
    await expect(item(page, "roadmap").getByTestId("board-title")).toHaveText("roadmap");

    await item(page, "roadmap").getByTestId("board-rename").click();
    await item(page, "roadmap").getByTestId("rename-input").fill("Q3 roadmap");
    await item(page, "roadmap").getByTestId("rename-save").click();

    await expect(item(page, "roadmap").getByTestId("board-title")).toHaveText("Q3 roadmap");
    // The slug — its identity and URL — is untouched by a rename.
    await expect(item(page, "roadmap")).toBeVisible();
  });

  test("archives a board and restores it from the archived view (R5)", async ({
    overview,
    hub,
  }) => {
    await seedBoard(hub.url, "old-notes");

    const page = await overview.open();
    await item(page, "old-notes").getByTestId("board-archive").click();
    await expect(item(page, "old-notes")).toHaveCount(0);

    await page.getByTestId("view-archived").click();
    await expect(item(page, "old-notes")).toBeVisible();

    await item(page, "old-notes").getByTestId("board-restore").click();
    await expect(item(page, "old-notes")).toHaveCount(0);

    await page.getByTestId("view-active").click();
    await expect(item(page, "old-notes")).toBeVisible();
  });
});
