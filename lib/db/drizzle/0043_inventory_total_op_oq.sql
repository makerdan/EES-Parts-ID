ALTER TABLE "inventory"
  ADD COLUMN "total_op_oq" integer
  GENERATED ALWAYS AS ("order_purchase" + "order_quantity") STORED NOT NULL;