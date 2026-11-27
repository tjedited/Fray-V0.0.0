#include "fray/fray_manager.hpp"

#include <cassert>
#include <filesystem>
#include <future>
#include <tuple>

namespace fs = std::filesystem;

int main(int argc, char** argv)
{
    assert(argc == 2);
    const fs::path root = argv[1];
    fray::FrayManager app;
    auto close = [&](const std::string& target, bool package)
    {
        std::promise<std::tuple<std::string, F_err, bool>> promise;
        auto future = promise.get_future();
        app.requestCloseProject(target, package, [&](const std::string& name, F_err result, bool packaged)
        {
            promise.set_value({name, result, packaged});
        });
        return future.get();
    };

    assert(std::get<1>(close("", false)) == fray::errors::PROJECT_NOT_FOUND);
    assert(app.openProject((root / "First").string()).get() == fray::errors::NONE);
    bool preference = true;
    assert(app.project("First").get("project.preferences.packageOnClose", preference) == fray::errors::NONE);
    assert(!preference);
    assert(app.openProject((root / "Second").string()).get() == fray::errors::NONE);
    assert(app.openProject((root / "Missing").string(), fray::files::ConflictChoice::Ask, {}, false,
                           fray::files::OpenMode::OpenExisting).get() == fray::errors::PROJECT_NOT_FOUND);
    auto second = close("", true);
    assert(std::get<0>(second) == "Second" && std::get<1>(second) == fray::errors::NONE && std::get<2>(second));
    assert(fs::is_regular_file(root / "Second.fry") && !fs::exists(root / "Second"));
    auto first = close("", false);
    assert(std::get<0>(first) == "First" && std::get<1>(first) == fray::errors::NONE && !std::get<2>(first));
    assert(fs::is_regular_file(root / "First" / "First.sqlite") && !fs::exists(root / "First.fry"));

    assert(app.openProject((root / "Second.fry").string()).get() == fray::errors::NONE);
    assert(app.project("Second").get("project.preferences.packageOnClose", preference) == fray::errors::NONE);
    assert(!preference);
    assert(app.project("Second").set("project.preferences.packageOnClose", true) == fray::errors::NONE);
    auto preferred = close("Second", false);
    assert(std::get<1>(preferred) == fray::errors::NONE && std::get<2>(preferred));
    assert(fs::is_regular_file(root / "Second.fry") && !fs::exists(root / "Second"));

    assert(app.openProject((root / "First").string()).get() == fray::errors::NONE);
    assert(app.openProject((root / "Second.fry").string()).get() == fray::errors::NONE);
    auto targeted = close("First", false);
    assert(std::get<0>(targeted) == "First" && std::get<1>(targeted) == fray::errors::NONE);
    assert(app.project("Second").isOpen());
    assert(std::get<1>(close("First", false)) == fray::errors::PROJECT_NOT_FOUND);
    assert(std::get<0>(close("", false)) == "Second");

    assert(app.openProject((root / "Retry").string()).get() == fray::errors::NONE);
    assert(fs::create_directory(root / "Retry.fry"));
    assert(std::get<1>(close("", true)) != fray::errors::NONE);
    assert(app.project("Retry").isOpen());
    assert(fs::is_regular_file(root / "Retry" / "Retry.sqlite"));
    assert(fs::remove(root / "Retry.fry"));
    auto retried = close("", false);
    assert(std::get<1>(retried) == fray::errors::NONE && std::get<2>(retried));
    assert(fs::is_regular_file(root / "Retry.fry") && !fs::exists(root / "Retry"));

    assert(app.openProject((root / "Shutdown").string()).get() == fray::errors::NONE);
    std::promise<F_err> completed;
    auto result = completed.get_future();
    app.requestCloseProject("", true, [&](const std::string&, F_err error, bool) { completed.set_value(error); });
    app.shutdown();
    assert(result.get() == fray::errors::NONE);
    assert(fs::is_regular_file(root / "Shutdown.fry") && !fs::exists(root / "Shutdown"));
}
