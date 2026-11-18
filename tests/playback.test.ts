import { expect, test } from "@playwright/test";

const playButton = "[data-testid='contol-bar--play-button']";
const kickNotes = "[data-testid='note-list--kick'] > button:not(:first-child)";

test("Pausing and resuming keeps the play state consistent", async ({
  page,
}) => {
  await page.goto("/");
  const button = page.locator(playButton);
  const icon = button.locator("span");

  await button.click();
  await expect(icon).toHaveClass(/.*ph--pause-fill.*/);
  await button.click();
  await expect(icon).toHaveClass(/.*ph--play-fill.*/);

  // Repeated toggles must not leave the button stuck in either state.
  await button.click();
  await expect(icon).toHaveClass(/.*ph--pause-fill.*/);
  await button.click();
  await expect(icon).toHaveClass(/.*ph--play-fill.*/);
});

test("Playhead highlight clears on pause and restarts at the first step", async ({
  page,
}) => {
  await page.goto("/");
  const button = page.locator(playButton);
  const notes = page.locator(kickNotes);
  const highlighted = page.locator(
    "[data-testid='note-list--kick'] > button.btn-accent"
  );

  await button.click();
  await expect(highlighted.first()).toBeVisible();

  await button.click();
  await expect(highlighted).toHaveCount(0);

  // After restarting, the first grid step becomes audible again.
  await button.click();
  await expect(notes.first()).toHaveClass(/.*btn-accent.*/, {
    timeout: 5000,
  });

  await button.click();
  await expect(highlighted).toHaveCount(0);
});
