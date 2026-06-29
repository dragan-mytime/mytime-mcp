import { targetsFileSchema } from "@mytime/shared";
import { type TargetDbRow, rowToTarget } from "@mytime/db";
import { describe, expect, it } from "vitest";

// A representative sample row mimicking what the DB would return for b-watch
const bwatchRow: TargetDbRow = {
  id: "b-watch",
  name: "B-Watch",
  legalEntity: "Б-ВОЧ ДОО",
  isSelf: false,
  webEnabled: true,
  webUrl: "https://bwatch.mk/",
  webSource: "firecrawl",
  monobrand: false,
  perLocationStock: false,
  platform: "woocommerce",
  webLocations: [],
  social: {
    instagram: "https://www.instagram.com/bwatchshop/",
    facebook: "https://www.facebook.com/bwatchshop",
    tiktok: "https://www.tiktok.com/@bwatchshop",
  },
  registry: { central_registry_id: null },
};

// A row with no optional fields (chapter-03 style — web disabled, no social/registry)
const minimalRow: TargetDbRow = {
  id: "chapter-03",
  name: "Chapter 03",
  legalEntity: "КОНЦЕПТ ТРЕЈД ОНЕ ДООЕЛ",
  isSelf: false,
  webEnabled: false,
  webUrl: null,
  webSource: null,
  monobrand: false,
  perLocationStock: null,
  platform: null,
  webLocations: null,
  social: {
    instagram: "https://www.instagram.com/chapter.03_",
    facebook: "https://www.facebook.com/p/Chapter03-100063521080809/",
  },
  registry: { central_registry_id: null },
};

describe("rowToTarget", () => {
  it("maps b-watch row to correct Target shape", () => {
    const t = rowToTarget(bwatchRow);

    expect(t.id).toBe("b-watch");
    expect(t.name).toBe("B-Watch");
    expect(t.is_self).toBe(false);
    expect(t.legal_entity).toBe("Б-ВОЧ ДОО");
    expect(t.web.enabled).toBe(true);
    expect(t.web.url).toBe("https://bwatch.mk/");
    expect(t.web.platform).toBe("woocommerce");
    expect(t.social?.facebook).toBe("https://www.facebook.com/bwatchshop");
    expect(t.web.locations).toEqual([]);
  });

  it("validates b-watch row via targetsFileSchema", () => {
    const t = rowToTarget(bwatchRow);
    const result = targetsFileSchema.safeParse({ targets: [t] });
    expect(result.success).toBe(true);
  });

  it("maps a minimal (web-disabled) row without throwing", () => {
    const t = rowToTarget(minimalRow);
    expect(t.id).toBe("chapter-03");
    expect(t.web.enabled).toBe(false);
    expect(t.web.platform).toBeUndefined();
    expect(t.web.locations).toEqual([]);
    expect(t.registry?.central_registry_id).toBeNull();
  });

  it("validates a batch of rows via targetsFileSchema", () => {
    const mapped = [bwatchRow, minimalRow].map(rowToTarget);
    const result = targetsFileSchema.safeParse({ targets: mapped });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targets).toHaveLength(2);
    }
  });
});
