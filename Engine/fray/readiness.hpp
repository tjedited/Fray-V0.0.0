/* readiness.hpp */

#ifndef _FRAY_READINESS_HPP_
#define _FRAY_READINESS_HPP_

#include <mutex>
#include <set>

#include "fray.pb.h"

namespace fray
{
    namespace routing
    {
        // What this process currently believes about the other processes. Nothing is assumed about startup order:
        // a peer is ready only after it has said so, and it can say so at any time.
        class PeerReadiness
        {
        private:
            mutable std::mutex _mutex;
            std::set<ProcessKind> _ready;

        public:
            // Returns true only when the peer was not ready before, so callers act once per transition.
            bool markReady(ProcessKind kind)
            {
                std::lock_guard<std::mutex> lock(_mutex);
                return _ready.insert(kind).second;
            }

            void markNotReady(ProcessKind kind)
            {
                std::lock_guard<std::mutex> lock(_mutex);
                _ready.erase(kind);
            }

            bool isReady(ProcessKind kind) const
            {
                std::lock_guard<std::mutex> lock(_mutex);
                return _ready.count(kind) != 0;
            }
        };
    }
}

#endif
