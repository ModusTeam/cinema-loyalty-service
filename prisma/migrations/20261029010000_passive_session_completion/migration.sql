CREATE TABLE "session_completion_facts" (
    "event_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "completed_at_utc" VARCHAR(27) NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_completion_facts_pkey" PRIMARY KEY ("event_id"),
    CONSTRAINT "session_completion_v1" CHECK ("schema_version" = 1 AND "revision" = 1),
    CONSTRAINT "session_completion_utc_microseconds" CHECK (
        "completed_at_utc" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
        AND left("completed_at_utc", 4) <> '0000'
    )
);

CREATE UNIQUE INDEX "session_completion_facts_session_id_revision_key"
    ON "session_completion_facts"("session_id", "revision");
