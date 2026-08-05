/*
  Warnings:

  - Added the required column `order_index` to the `planned_sets` table without a default value. This is not possible if the table is not empty.
  - Added the required column `focus` to the `workout_sessions` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "planned_sets" ADD COLUMN     "order_index" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "workout_sessions" ADD COLUMN     "focus" TEXT NOT NULL;
