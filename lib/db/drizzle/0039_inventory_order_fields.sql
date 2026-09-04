ALTER TABLE "inventory"
  ADD COLUMN "order_purchase" integer NOT NULL DEFAULT 0,
  ADD COLUMN "order_quantity" integer NOT NULL DEFAULT 0;