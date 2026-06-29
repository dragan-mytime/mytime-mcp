import { createPool } from "@mytime/shared";
import type { DbProductRow } from "./types.js";

/** Sample up to n products for a target from the latest captured_date,
 *  biased toward items already flagged on-sale, then random. */
export async function sampleProducts(
  dbUrl: string,
  targetId: string,
  n: number,
): Promise<DbProductRow[]> {
  const pool = createPool(dbUrl);
  try {
    const { rows } = await pool.query<DbProductRow>(
      `
      with latest as (select max(captured_date) d from prices)
      select pr.id as "productId", pr.target_id as "targetId", pr.external_id as "externalId",
             pr.url, pr.name, pr.brand, pr.model_ref as "modelRef", pr.category,
             p.price::float8 as price, p.sale_price::float8 as "salePrice",
             p.discount_pct::float8 as "discountPct",
             i.stock_status as "stockStatus"
      from products pr
      join latest on true
      join prices p on p.product_id = pr.id and p.captured_date = latest.d
      left join (
        select distinct on (product_id) product_id, stock_status
        from inventory_snapshots
        join latest on captured_date = latest.d
        order by product_id
      ) i on i.product_id = pr.id
      where pr.target_id = $1 and pr.url is not null
      order by (p.sale_price is not null) desc, random()
      limit $2
      `,
      [targetId, n],
    );
    return rows;
  } finally {
    await pool.end();
  }
}
