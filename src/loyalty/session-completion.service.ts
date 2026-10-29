import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { withTransactionRetry } from '../prisma/profile-transaction';
import { PermanentMessageError } from './consumers/message-failure';
import { parseSessionCompleted } from './dto/session-completed.dto';

@Injectable()
export class SessionCompletionService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(input: unknown): Promise<void> {
    const fact = parseSessionCompleted(input);
    await withTransactionRetry(this.prisma, async (tx) => {
      // The two unique indexes arbitrate concurrent first deliveries. No profile
      // exists or needs locking for a session-scoped passive fact.
      const inserted = await tx.sessionCompletionFact.createMany({
        data: fact,
        skipDuplicates: true,
      });
      if (inserted.count === 1) return;

      const existing = await tx.sessionCompletionFact.findMany({
        where: {
          OR: [
            { eventId: fact.eventId },
            { sessionId: fact.sessionId, revision: fact.revision },
          ],
        },
      });
      if (existing.length === 0)
        throw new Error('SESSION_COMPLETION_RECEIPT_UNAVAILABLE');
      if (
        existing.length !== 1 ||
        existing.some(
          (row) =>
            row.eventId !== fact.eventId ||
            row.sessionId !== fact.sessionId ||
            row.schemaVersion !== fact.schemaVersion ||
            row.revision !== fact.revision ||
            row.completedAtUtc !== fact.completedAtUtc,
        )
      )
        throw new PermanentMessageError('SESSION_COMPLETION_IDENTITY_CONFLICT');
    });
  }
}
