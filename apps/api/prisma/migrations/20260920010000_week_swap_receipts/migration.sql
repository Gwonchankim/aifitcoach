CREATE TABLE "week_swap_receipts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "request_hash" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  CONSTRAINT "week_swap_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "week_swap_receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ux_week_swap_receipts_user_client" ON "week_swap_receipts"("user_id", "client_id");
