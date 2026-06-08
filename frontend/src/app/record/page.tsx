import { Suspense } from 'react';
import RecordingPage from '@/components/RecordingPage';

export default function Page() {
  return (
    <Suspense>
      <RecordingPage />
    </Suspense>
  );
}
