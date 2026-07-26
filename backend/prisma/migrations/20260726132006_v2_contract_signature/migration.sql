-- AlterTable
ALTER TABLE "contract_versions" ADD COLUMN     "signature_file_id" UUID,
ADD COLUMN     "signed_at" TIMESTAMPTZ(6),
ADD COLUMN     "signer_name" VARCHAR(80);

-- AddForeignKey
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_signature_file_id_fkey" FOREIGN KEY ("signature_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
