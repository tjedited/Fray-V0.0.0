#include "fray/state_manager.hpp"
#include "fray/state_manager.hpp"

#include <type_traits>

static_assert(!std::is_copy_constructible<fray::state::StateManager>::value, "StateManager must not be copied");
static_assert(!std::is_copy_assignable<fray::state::StateManager>::value, "StateManager must not be copy-assigned");
static_assert(!std::is_invocable_v<decltype(&fray::state::StateManager::open),
                                   fray::state::StateManager&, const char*, const std::string&, const std::string&>,
              "StateManager must not open database paths directly");

F_err verifyStateManagerSeparateTranslationUnit(fray::state::StateManager& state, int& value)
{
    return state.get("shared", value);
}
